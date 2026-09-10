import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';

import { errorForLog } from './logger.js';
import { connectRedis } from './redis.js';

test('Redis initialization preserves a safe connection-event code', async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );

  await assert.rejects(
    connectRedis(`redis://user:secret@127.0.0.1:${address.port}`, {
      connectTimeoutMs: 300,
    }),
    (error: unknown) => {
      assert.deepEqual(errorForLog(error), {
        name: 'DependencyError',
        code: 'ECONNREFUSED',
        dependency: 'redis',
      });
      assert.doesNotMatch(
        JSON.stringify(errorForLog(error)),
        /user|secret|127\.0\.0\.1/,
      );
      return true;
    },
  );
});
