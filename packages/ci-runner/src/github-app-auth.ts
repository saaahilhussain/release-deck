import { constants, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';

export interface GitHubAppConfiguration {
  readonly appId: string;
  readonly installationId: string;
  readonly privateKeyPath: string;
}

export interface GitHubRepository {
  readonly owner: string;
  readonly repository: string;
  readonly path: string;
}

export class GitHubAppAuthenticationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'GITHUB_APP_AUTH_FAILED'
      | 'CHECKOUT_TIMEOUT'
      | 'CHECKOUT_CANCELLED' = 'GITHUB_APP_AUTH_FAILED',
  ) {
    super(message);
    this.name = 'GitHubAppAuthenticationError';
  }
}

export interface GitHubAppAuth {
  installationToken(
    repository: GitHubRepository,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<string>;
}

/** Deliberately narrower than public/local checkout: no redirects or URL aliases. */
export function githubRepository(value: string): GitHubRepository | undefined {
  const match =
    /^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9._-]{1,100}?)(\.git)?$/i.exec(
      value,
    );
  if (!match || match[2] === '.' || match[2] === '..') return undefined;
  return {
    owner: match[1]!.toLowerCase(),
    repository: match[2]!.toLowerCase(),
    path: `${match[1]}/${match[2]}${match[3] ?? ''}`.toLowerCase(),
  };
}

/** RS256 only, backdated 60s and valid for five minutes from the local clock. */
export function createGitHubAppJwt(
  appId: string,
  key: KeyObject,
  now = Date.now(),
): string {
  try {
    if (
      !/^[1-9][0-9]{0,19}$/.test(appId) ||
      key.type !== 'private' ||
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error();
    }
    const seconds = Math.floor(now / 1000);
    if (!Number.isSafeInteger(seconds) || seconds < 60) throw new Error();
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({ iss: appId, iat: seconds - 60, exp: seconds + 300 }),
    ).toString('base64url');
    const input = `${header}.${payload}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key, padding: constants.RSA_PKCS1_PADDING }).toString('base64url')}`;
  } catch {
    throw new GitHubAppAuthenticationError('GitHub App JWT creation failed');
  }
}

async function responseFields(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 65_536) throw new Error();
      chunks.push(value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error();
    return result as Record<string, unknown>;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Load the key only in the trusted worker. No key/JWT is passed to Git. */
export async function createGitHubAppAuth(
  config: GitHubAppConfiguration,
  dependencies: { readonly fetch?: typeof fetch; readonly now?: () => number } = {},
): Promise<GitHubAppAuth> {
  let key: KeyObject;
  try {
    if (
      !/^[1-9][0-9]{0,19}$/.test(config.appId) ||
      !/^[1-9][0-9]{0,19}$/.test(config.installationId)
    )
      throw new Error();
    const file = await open(
      config.privateKeyPath,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > 32_768 ||
        (process.platform !== 'win32' &&
          ((info.mode & 0o077) !== 0 || ![0, process.getuid!()].includes(info.uid)))
      )
        throw new Error();
      key = createPrivateKey(await file.readFile());
      createGitHubAppJwt(config.appId, key); // Validate algorithm/key before consuming jobs.
    } finally {
      await file.close();
    }
  } catch {
    throw new GitHubAppAuthenticationError(
      'GitHub App signing key configuration is invalid',
    );
  }
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  return {
    async installationToken(repository, callerSignal, timeoutMs) {
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(),
        Math.max(1, Math.min(10_000, timeoutMs)),
      );
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, timeout.signal])
        : timeout.signal;
      try {
        signal.throwIfAborted();
        // Repository names are bounded by the same GitHub coordinate contract.
        if (
          !githubRepository(
            `https://github.com/${repository.owner}/${repository.repository}`,
          )
        )
          throw new Error();
        const response = await request(
          `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
          {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: {
              Authorization: `Bearer ${createGitHubAppJwt(config.appId, key, now())}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'ReleaseDeck',
              'X-GitHub-Api-Version': '2026-03-10',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              repositories: [repository.repository],
              permissions: { contents: 'read' },
            }),
          },
        );
        if (response.status !== 201) {
          await response.body?.cancel().catch(() => undefined);
          throw new GitHubAppAuthenticationError(
            `GitHub installation token request failed with status ${response.status}`,
          );
        }
        const fields = await responseFields(response);
        const expires =
          typeof fields.expires_at === 'string' ? Date.parse(fields.expires_at) : NaN;
        const permissions = fields.permissions;
        if (
          typeof fields.token !== 'string' ||
          !/^[A-Za-z0-9_.-]{1,4096}$/.test(fields.token) ||
          !Number.isFinite(expires) ||
          expires <= now() + 30_000 ||
          expires > now() + 3_900_000 ||
          !permissions ||
          typeof permissions !== 'object' ||
          Array.isArray(permissions) ||
          (permissions as Record<string, unknown>).contents !== 'read' ||
          Object.entries(permissions).some(
            ([name, value]) =>
              !['contents', 'metadata'].includes(name) || value !== 'read',
          )
        )
          throw new Error();
        return fields.token;
      } catch (error) {
        if (callerSignal?.aborted)
          throw new GitHubAppAuthenticationError(
            'GitHub checkout cancelled',
            'CHECKOUT_CANCELLED',
          );
        if (timeout.signal.aborted)
          throw new GitHubAppAuthenticationError(
            'GitHub installation token request timed out',
            'CHECKOUT_TIMEOUT',
          );
        if (error instanceof GitHubAppAuthenticationError) throw error;
        throw new GitHubAppAuthenticationError('GitHub App authentication failed');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
