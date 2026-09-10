import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createLogger } from '@releasedeck/runtime';

import { createApp, type HealthDependency } from './app.js';

const available: HealthDependency = { async ping() {} };
const unavailable: HealthDependency = {
  async ping() {
    throw new Error('down');
  },
};

async function withApp(
  mongo: HealthDependency,
  redis: HealthDependency,
  assertion: (url: string) => Promise<void>,
  healthTimeoutMs?: number,
): Promise<void> {
  const server = createApp({
    mongo,
    redis,
    logger: createLogger('silent'),
    ...(healthTimeoutMs === undefined ? {} : { healthTimeoutMs }),
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('expected TCP server address');
  try {
    await assertion(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('GET /health reports connected dependencies', async () => {
  await withApp(available, available, async (url) => {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'healthy',
      dependencies: { mongodb: 'available', redis: 'available' },
    });
  });
});

test('GET /health returns 503 when a dependency ping fails', async () => {
  await withApp(available, unavailable, async (url) => {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: 'unavailable',
      dependencies: { mongodb: 'available', redis: 'unavailable' },
    });
  });
});

test('GET /health bounds a stalled dependency check', async () => {
  const stalled: HealthDependency = { ping: () => new Promise<void>(() => undefined) };
  await withApp(
    stalled,
    available,
    async (url) => {
      const startedAt = performance.now();
      const response = await fetch(`${url}/health`);
      assert.equal(response.status, 503);
      assert.ok(performance.now() - startedAt < 500);
    },
    10,
  );
});
