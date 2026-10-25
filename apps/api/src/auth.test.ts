import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createLogger } from '@releasedeck/runtime';

import {
  AUTH_CONSTANTS,
  createOperatorAuth,
  hashOperatorPassword,
  parseOperatorPasswordHash,
  type OperatorAuthOptions,
} from './auth.js';
import { createApp } from './app.js';
import type { DeploymentEventOptions } from './routes.js';
import type { ApiRepositories, DeploymentRecord, ProjectRecord } from './services.js';

const ORIGIN = 'http://dashboard.test';
const PASSWORD = 'correct horse battery staple';
const HASH_A = `scrypt$v1$N=65536,r=8,p=2$${Buffer.alloc(16, 1).toString('base64url')}$${Buffer.alloc(32, 2).toString('base64url')}`;
const HASH_B = `scrypt$v1$N=65536,r=8,p=2$${Buffer.alloc(16, 3).toString('base64url')}$${Buffer.alloc(32, 4).toString('base64url')}`;

type Entry = { value: string; expiresAt?: number };

class FakeRedis {
  readonly entries = new Map<string, Entry>();
  fail = false;

  constructor(readonly now: () => number) {}

  private active(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    if (this.fail) throw new Error('redis unavailable');
    return this.active(key)?.value ?? null;
  }

  async set(key: string, value: string, ...options: Array<string | number>) {
    if (this.fail) throw new Error('redis unavailable');
    const px = options.indexOf('PX');
    const ttl = px >= 0 ? Number(options[px + 1]) : undefined;
    if (options.includes('NX') && this.active(key)) return null;
    if (options.includes('XX') && !this.active(key)) return null;
    this.entries.set(key, {
      value,
      ...(ttl === undefined ? {} : { expiresAt: this.now() + ttl }),
    });
    return 'OK';
  }

  async del(...keys: string[]) {
    if (this.fail) throw new Error('redis unavailable');
    let removed = 0;
    for (const key of keys) removed += Number(this.entries.delete(key));
    return removed;
  }

  async pttl(key: string) {
    const entry = this.active(key);
    return entry?.expiresAt === undefined
      ? entry
        ? -1
        : -2
      : entry.expiresAt - this.now();
  }

  async eval(
    script: string,
    _numberOfKeys: number,
    accountKey: string,
    ipKey: string,
    window?: string,
    accountLimit?: string,
    ipLimit?: string,
  ) {
    if (this.fail) throw new Error('redis unavailable');
    if (script.includes("redis.call('DECR'")) {
      for (const key of [accountKey, ipKey]) {
        const entry = this.active(key);
        const count = Number(entry?.value ?? 0);
        if (count <= 1) this.entries.delete(key);
        else this.entries.set(key, { ...entry!, value: String(count - 1) });
      }
      return 1;
    }
    const account = Number(this.active(accountKey)?.value ?? 0);
    const ip = Number(this.active(ipKey)?.value ?? 0);
    if (account >= Number(accountLimit) || ip >= Number(ipLimit)) {
      return [0, account, ip, await this.pttl(accountKey), await this.pttl(ipKey)];
    }
    const update = (key: string, count: number) => {
      const existing = this.active(key);
      this.entries.set(key, {
        value: String(count + 1),
        expiresAt: existing?.expiresAt ?? this.now() + Number(window),
      });
    };
    update(accountKey, account);
    update(ipKey, ip);
    return [
      1,
      account + 1,
      ip + 1,
      await this.pttl(accountKey),
      await this.pttl(ipKey),
    ];
  }

  sessionKeys() {
    return [...this.entries.keys()].filter((key) => key.includes(':session:'));
  }
}

const project: ProjectRecord = {
  id: '01234567-89ab-4cde-8012-3456789abcde',
  provider: 'github',
  owner: 'example',
  repository: 'releasedeck',
  defaultBranch: 'main',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};
const deployment: DeploymentRecord = {
  id: 'fedcba98-7654-4321-8fed-cba987654321',
  projectId: project.id,
  provider: 'github',
  commitSha: '0123456789abcdef0123456789abcdef01234567',
  status: 'QUEUED',
  stage: 'QUEUED',
  version: 1,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
};

function repositories(): ApiRepositories {
  return {
    projects: {
      create: async () => project,
      findById: async () => project,
      findByCoordinates: async () => null,
      list: async () => ({ items: [project], nextCursor: null }),
    },
    deployments: {
      createQueued: async () => {
        throw new Error('not used');
      },
      findById: async (id) => (id === deployment.id ? deployment : null),
      findBySourceWebhookEventId: async () => null,
      listByProject: async () => ({ items: [], nextCursor: null }),
      transition: async () => {
        throw new Error('not used');
      },
    },
    webhookEvents: {
      create: async () => {
        throw new Error('not used');
      },
      findByDeliveryId: async () => null,
      transition: async () => {
        throw new Error('not used');
      },
      listPending: async () => [],
    },
  } as ApiRepositories;
}

type Started = {
  url: string;
  redis: FakeRedis;
  close(): Promise<void>;
};

async function start(
  options: {
    redis?: FakeRedis;
    now?: () => number;
    hash?: string;
    secureCookies?: boolean;
    passwordVerifier?: OperatorAuthOptions['passwordVerifier'];
    maxConcurrentPasswordVerifications?: number;
    deploymentEventOptions?: DeploymentEventOptions;
  } = {},
): Promise<Started> {
  let randomValue = 8;
  const now = options.now ?? (() => Date.now());
  const redis = options.redis ?? new FakeRedis(now);
  const auth = createOperatorAuth({
    redis: redis as unknown as OperatorAuthOptions['redis'],
    operatorId: 'operator',
    passwordHash: options.hash ?? HASH_A,
    allowedOrigin: ORIGIN,
    secureCookies: options.secureCookies ?? false,
    now,
    randomBytes: (size) => Buffer.alloc(size, randomValue++),
    passwordVerifier:
      options.passwordVerifier ?? (async (password) => password === PASSWORD),
    ...(options.maxConcurrentPasswordVerifications === undefined
      ? {}
      : {
          maxConcurrentPasswordVerifications:
            options.maxConcurrentPasswordVerifications,
        }),
  });
  const server = createApp({
    mongo: { ping: async () => undefined },
    redis: { ping: async () => undefined },
    logger: createLogger('silent'),
    repositories: repositories(),
    operatorAuth: auth,
    ...(options.deploymentEventOptions === undefined
      ? {}
      : { deploymentEventOptions: options.deploymentEventOptions }),
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    redis,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function login(url: string, password = PASSWORD, origin = ORIGIN) {
  const response = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ operatorId: 'operator', password }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  let body: { csrfToken: string } | undefined;
  if (response.ok) {
    const session = await fetch(`${url}/api/auth/session`, { headers: { cookie } });
    if (session.ok) body = (await session.json()) as { csrfToken: string };
  }
  return { response, cookie, body };
}

test('scrypt credentials use the versioned bounded profile and reject malformed configuration', async () => {
  const hash = await hashOperatorPassword(PASSWORD, (size) => Buffer.alloc(size, 7));
  assert.match(hash, /^scrypt\$v1\$N=65536,r=8,p=2\$/);
  assert.doesNotThrow(() => parseOperatorPasswordHash(hash));
  assert.throws(() => parseOperatorPasswordHash('scrypt$v1$invalid'), /invalid/);
  assert.rejects(() => hashOperatorPassword('too short'), /between 16 and 1024/);
});

test('operator routes deny by default and valid sessions enforce origin, CSRF, logout and sanitized 404', async () => {
  const app = await start();
  try {
    assert.equal((await fetch(`${app.url}/api/projects`)).status, 401);
    assert.equal((await fetch(`${app.url}/api/not-a-route`)).status, 401);
    assert.equal(
      (
        await fetch(
          `${app.url}/api/deployments/fedcba98-7654-4321-8fed-cba987654321/events`,
        )
      ).status,
      401,
    );
    assert.equal((await fetch(`${app.url}/health`)).status, 200);

    const crossOrigin = await login(app.url, PASSWORD, 'https://attacker.test');
    assert.equal(crossOrigin.response.status, 403);
    const authenticated = await login(app.url);
    assert.equal(authenticated.response.status, 204);
    assert.match(authenticated.cookie, /^releasedeck_session_dev=/);
    const setCookie = authenticated.response.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.doesNotMatch(setCookie, /Domain=/i);
    assert.doesNotMatch(setCookie, /; Secure/i);
    assert.ok(authenticated.body?.csrfToken);
    assert.equal(app.redis.sessionKeys().length, 1);
    assert.ok(
      app.redis
        .sessionKeys()
        .every((key) => !key.includes(authenticated.cookie.split('=')[1]!)),
    );

    const session = await fetch(`${app.url}/api/auth/session`, {
      headers: { cookie: authenticated.cookie },
    });
    assert.equal(session.status, 200);
    assert.equal(
      (
        await fetch(`${app.url}/api/projects`, {
          headers: { cookie: authenticated.cookie },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${app.url}/api/not-a-route`, {
          headers: { cookie: authenticated.cookie },
        })
      ).status,
      404,
    );

    const projectBody = JSON.stringify({
      owner: 'example',
      repository: 'releasedeck',
      defaultBranch: 'main',
    });
    const missingCsrf = await fetch(`${app.url}/api/projects`, {
      method: 'POST',
      headers: {
        cookie: authenticated.cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: projectBody,
    });
    assert.equal(missingCsrf.status, 403);
    const crossSite = await fetch(`${app.url}/api/projects`, {
      method: 'POST',
      headers: {
        cookie: authenticated.cookie,
        origin: 'https://attacker.test',
        'content-type': 'application/json',
        'x-releasedeck-csrf': authenticated.body!.csrfToken,
      },
      body: projectBody,
    });
    assert.equal(crossSite.status, 403);
    const created = await fetch(`${app.url}/api/projects`, {
      method: 'POST',
      headers: {
        cookie: authenticated.cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-releasedeck-csrf': authenticated.body!.csrfToken,
      },
      body: projectBody,
    });
    assert.equal(created.status, 201);

    const logout = await fetch(`${app.url}/api/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: authenticated.cookie,
        origin: ORIGIN,
        'x-releasedeck-csrf': authenticated.body!.csrfToken,
      },
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.equal(
      (
        await fetch(`${app.url}/api/auth/session`, {
          headers: { cookie: authenticated.cookie },
        })
      ).status,
      401,
    );
  } finally {
    await app.close();
  }
});

test('secure mode uses a __Host cookie and login replaces any supplied session identifier', async () => {
  const app = await start({ secureCookies: true });
  try {
    const result = await fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie:
          '__Host-releasedeck_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
      body: JSON.stringify({ operatorId: 'operator', password: PASSWORD }),
    });
    assert.equal(result.status, 204);
    const cookie = result.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^__Host-releasedeck_session=/);
    assert.match(cookie, /; Secure/);
    assert.doesNotMatch(cookie, /Domain=/i);
    assert.doesNotMatch(cookie, /=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/);
  } finally {
    await app.close();
  }
});

test('idle, absolute, revoked and credential-rotated sessions are rejected', async () => {
  let time = 1_800_000_000_000;
  const now = () => time;
  const redis = new FakeRedis(now);
  let app = await start({ redis, now });
  const first = await login(app.url);
  assert.equal(first.response.status, 204);
  time += AUTH_CONSTANTS.idleMs;
  assert.equal(
    (await fetch(`${app.url}/api/auth/session`, { headers: { cookie: first.cookie } }))
      .status,
    401,
  );

  const second = await login(app.url);
  for (let index = 0; index < 16; index += 1) {
    time += 29 * 60 * 1_000;
    assert.equal(
      (
        await fetch(`${app.url}/api/auth/session`, {
          headers: { cookie: second.cookie },
        })
      ).status,
      200,
    );
  }
  time += 17 * 60 * 1_000;
  assert.equal(
    (await fetch(`${app.url}/api/auth/session`, { headers: { cookie: second.cookie } }))
      .status,
    401,
  );

  const third = await login(app.url);
  await redis.del(...redis.sessionKeys());
  assert.equal(
    (await fetch(`${app.url}/api/auth/session`, { headers: { cookie: third.cookie } }))
      .status,
    401,
  );

  const fourth = await login(app.url);
  await app.close();
  app = await start({ redis, now, hash: HASH_B });
  try {
    assert.equal(
      (
        await fetch(`${app.url}/api/auth/session`, {
          headers: { cookie: fourth.cookie },
        })
      ).status,
      401,
    );
  } finally {
    await app.close();
  }
});

test('unauthorized roles and Redis failures deny existing sessions', async () => {
  const app = await start();
  try {
    const authenticated = await login(app.url);
    const key = app.redis.sessionKeys()[0];
    assert.ok(key);
    const stored = app.redis.entries.get(key);
    assert.ok(stored);
    app.redis.entries.set(key, {
      ...stored,
      value: JSON.stringify({ ...JSON.parse(stored.value), role: 'viewer' }),
    });
    assert.equal(
      (
        await fetch(`${app.url}/api/auth/session`, {
          headers: { cookie: authenticated.cookie },
        })
      ).status,
      403,
    );
    app.redis.fail = true;
    assert.equal(
      (
        await fetch(`${app.url}/api/auth/session`, {
          headers: { cookie: authenticated.cookie },
        })
      ).status,
      503,
    );
  } finally {
    await app.close();
  }
});

test('authenticated SSE streams close after expiry or server-side revocation', async () => {
  let time = 1_800_000_000_000;
  const app = await start({
    now: () => time,
    deploymentEventOptions: {
      pollIntervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
      maxConnectionMs: 1_000,
      sessionRevalidationIntervalMs: 10,
    },
  });
  try {
    const expiring = await login(app.url);
    const expiringResponse = await fetch(
      `${app.url}/api/deployments/${deployment.id}/events`,
      { headers: { cookie: expiring.cookie } },
    );
    assert.equal(expiringResponse.status, 200);
    const expiringReader = expiringResponse.body!.getReader();
    const initial = await expiringReader.read();
    assert.match(new TextDecoder().decode(initial.value), /event: deployment/);
    time += AUTH_CONSTANTS.idleMs;
    assert.equal((await expiringReader.read()).done, true);

    const revoked = await login(app.url);
    const revokedResponse = await fetch(
      `${app.url}/api/deployments/${deployment.id}/events`,
      { headers: { cookie: revoked.cookie } },
    );
    assert.equal(revokedResponse.status, 200);
    const revokedReader = revokedResponse.body!.getReader();
    const revokedInitial = await revokedReader.read();
    assert.match(new TextDecoder().decode(revokedInitial.value), /event: deployment/);
    await app.redis.del(...app.redis.sessionKeys());
    assert.equal((await revokedReader.read()).done, true);
    assert.equal(
      (
        await fetch(`${app.url}/api/deployments/${deployment.id}/events`, {
          headers: { cookie: revoked.cookie },
        })
      ).status,
      401,
    );
  } finally {
    await app.close();
  }
});

test('rate limits cool down, password verification is bounded, and Redis errors fail closed', async () => {
  let time = 1_800_000_000_000;
  const app = await start({ now: () => time });
  try {
    for (let attempt = 0; attempt < AUTH_CONSTANTS.accountFailureLimit; attempt += 1) {
      assert.equal((await login(app.url, 'wrong password')).response.status, 401);
    }
    const blocked = await login(app.url, 'wrong password');
    assert.equal(blocked.response.status, 429);
    assert.ok(Number(blocked.response.headers.get('retry-after')) > 0);
    time += AUTH_CONSTANTS.rateWindowMs;
    assert.equal((await login(app.url, 'wrong password')).response.status, 401);
    app.redis.fail = true;
    assert.equal((await login(app.url)).response.status, 503);
  } finally {
    await app.close();
  }

  const ipLimited = await start();
  try {
    assert.equal((await login(ipLimited.url, 'wrong password')).response.status, 401);
    const ipKey = [...ipLimited.redis.entries.keys()].find((key) =>
      key.includes(':ip:'),
    );
    assert.ok(ipKey);
    const entry = ipLimited.redis.entries.get(ipKey);
    ipLimited.redis.entries.set(ipKey, {
      value: String(AUTH_CONSTANTS.ipFailureLimit),
      ...(entry?.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
    });
    assert.equal((await login(ipLimited.url, 'wrong password')).response.status, 429);
  } finally {
    await ipLimited.close();
  }

  let release!: (value: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const bounded = await start({
    maxConcurrentPasswordVerifications: 2,
    passwordVerifier: () => gate,
  });
  try {
    const first = login(bounded.url);
    const second = login(bounded.url);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await login(bounded.url)).response.status, 503);
    release(false);
    assert.deepEqual(
      (await Promise.all([first, second])).map(({ response }) => response.status),
      [401, 401],
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await login(bounded.url)).response.status, 401);
    }
    assert.equal((await login(bounded.url)).response.status, 429);
  } finally {
    await bounded.close();
  }

  const releases = new Map<string, (value: boolean) => void>();
  const concurrent = await start({
    maxConcurrentPasswordVerifications: 2,
    passwordVerifier: (password) =>
      new Promise<boolean>((resolve) => releases.set(password, resolve)),
  });
  try {
    const failed = login(concurrent.url, 'concurrent invalid password');
    const valid = login(concurrent.url);
    while (releases.size < 2) await new Promise((resolve) => setImmediate(resolve));
    releases.get(PASSWORD)!(true);
    assert.equal((await valid).response.status, 204);
    releases.get('concurrent invalid password')!(false);
    assert.equal((await failed).response.status, 401);
    const counts = [...concurrent.redis.entries.entries()]
      .filter(([key]) => key.includes(':rate:'))
      .map(([, entry]) => Number(entry.value));
    assert.deepEqual(counts.sort(), [1, 1]);
  } finally {
    await concurrent.close();
  }
});
