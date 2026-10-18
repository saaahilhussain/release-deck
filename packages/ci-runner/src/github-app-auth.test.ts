import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createGitHubAppAuth,
  createGitHubAppJwt,
  githubRepository,
} from './github-app-auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = 1_790_000_000_000;
const repository = githubRepository('https://github.com/owner/repository.git')!;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'releasedeck-app-test-'));
  const privateKeyPath = join(directory, 'app.pem');
  await writeFile(privateKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o600,
  });
  return {
    config: { appId: '123', installationId: '456', privateKeyPath },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return Response.json(
    {
      token: 'installation-token-canary',
      expires_at: new Date(now + 3_600_000).toISOString(),
      permissions: { contents: 'read', metadata: 'read' },
      ...overrides,
    },
    { status: 201 },
  );
}

test('JWT is deterministic RS256 with expected issuer, clock skew, bounded expiry and valid signature', () => {
  const jwt = createGitHubAppJwt('123', privateKey, now);
  assert.equal(jwt, createGitHubAppJwt('123', privateKey, now));
  const [header, claims, signature] = jwt.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), {
    alg: 'RS256',
    typ: 'JWT',
  });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
    iss: '123',
    iat: now / 1000 - 60,
    exp: now / 1000 + 300,
  });
  assert.equal(
    verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
  const wrongKey = generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => createGitHubAppJwt('123', wrongKey, now), /JWT creation failed/);
  assert.throws(
    () => createGitHubAppJwt('invalid-secret-value', privateKey, now),
    /JWT creation failed/,
  );
});

test('installation request uses only App JWT, fixed GitHub endpoint, read contents and one repository', async () => {
  const f = await fixture();
  let requests = 0;
  try {
    const auth = await createGitHubAppAuth(f.config, {
      now: () => now,
      fetch: async (url, init) => {
        requests++;
        assert.equal(url, 'https://api.github.com/app/installations/456/access_tokens');
        assert.equal(init?.method, 'POST');
        assert.equal(init?.redirect, 'error');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('Accept'), 'application/vnd.github+json');
        assert.equal(headers.get('User-Agent'), 'ReleaseDeck');
        assert.equal(
          headers.get('Authorization'),
          `Bearer ${createGitHubAppJwt('123', privateKey, now)}`,
        );
        assert.deepEqual(JSON.parse(String(init?.body)), {
          repositories: ['repository'],
          permissions: { contents: 'read' },
        });
        return tokenResponse();
      },
    });
    assert.equal(requests, 0, 'startup does not request a token');
    assert.equal(
      await auth.installationToken(repository, undefined, 1000),
      'installation-token-canary',
    );
    assert.equal(requests, 1);
  } finally {
    await f.cleanup();
  }
});

for (const status of [401, 403, 404, 500, 503]) {
  test(`token API status ${status} drops raw secret-bearing response`, async () => {
    const f = await fixture();
    try {
      const auth = await createGitHubAppAuth(f.config, {
        fetch: async () => new Response('secret-response-token-canary', { status }),
      });
      await assert.rejects(
        auth.installationToken(repository, undefined, 1000),
        (error: Error) => {
          assert.equal(
            error.message,
            `GitHub installation token request failed with status ${status}`,
          );
          assert.equal(error.cause, undefined);
          assert.equal(JSON.stringify(error).includes('secret-response'), false);
          return true;
        },
      );
    } finally {
      await f.cleanup();
    }
  });
}

test('invalid expiry/token/permissions/JSON and oversized responses fail without leaking bodies', async () => {
  const f = await fixture();
  try {
    const responses = [
      tokenResponse({ token: '' }),
      tokenResponse({ token: 'token\ninjection' }),
      tokenResponse({ expires_at: 'invalid' }),
      tokenResponse({ expires_at: new Date(now - 1).toISOString() }),
      tokenResponse({ permissions: { contents: 'write' } }),
      tokenResponse({ permissions: { contents: 'read', administration: 'read' } }),
      new Response('response-secret-canary', { status: 201 }),
      new Response('response-secret-canary'.repeat(5000), { status: 201 }),
    ];
    for (const response of responses) {
      const auth = await createGitHubAppAuth(f.config, {
        now: () => now,
        fetch: async () => response,
      });
      await assert.rejects(
        auth.installationToken(repository, undefined, 1000),
        /^GitHubAppAuthenticationError: GitHub App authentication failed$/,
      );
    }
  } finally {
    await f.cleanup();
  }
});

test('token request timeout, pre-cancellation and transport errors are bounded and sanitized', async () => {
  const f = await fixture();
  try {
    const auth = await createGitHubAppAuth(f.config, {
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('sensitive-request-header-canary')),
            { once: true },
          );
        }),
    });
    await assert.rejects(
      auth.installationToken(repository, undefined, 10),
      /request timed out/,
    );
    await assert.rejects(
      auth.installationToken(repository, AbortSignal.abort(), 1000),
      /checkout cancelled/,
    );
    const broken = await createGitHubAppAuth(f.config, {
      fetch: async () => {
        throw new Error('sensitive-request-header-canary');
      },
    });
    await assert.rejects(
      broken.installationToken(repository, undefined, 1000),
      /GitHub App authentication failed/,
    );
  } finally {
    await f.cleanup();
  }
});

test('malformed or insecure signing key fails safely before token requests', async () => {
  const f = await fixture();
  try {
    if (process.platform !== 'win32') {
      await chmod(f.config.privateKeyPath, 0o644);
      await assert.rejects(
        createGitHubAppAuth(f.config),
        /signing key configuration is invalid/,
      );
      await chmod(f.config.privateKeyPath, 0o600);
    }
    await writeFile(f.config.privateKeyPath, 'private-key-canary-invalid');
    await assert.rejects(createGitHubAppAuth(f.config), (error: Error) => {
      assert.equal(error.message, 'GitHub App signing key configuration is invalid');
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally {
    await f.cleanup();
  }
});

test('authentication repository scope rejects alternate hosts, protocols, credentials, encoding and traversal', () => {
  for (const url of [
    'https://example.com/owner/repo.git',
    'http://github.com/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'file:///repo',
    'https://github.com.evil/owner/repo',
    'https://user:password@github.com/owner/repo',
    'https://github.com/owner/repo?next=other',
    'https://github.com/owner/..',
    'https://github.com/owner/%72epo',
    'https://github.com/owner/repo/other',
  ])
    assert.equal(githubRepository(url), undefined);
  assert.deepEqual(githubRepository('https://github.com/Owner/Repo.git'), {
    owner: 'owner',
    repository: 'repo',
    path: 'owner/repo.git',
  });
});
