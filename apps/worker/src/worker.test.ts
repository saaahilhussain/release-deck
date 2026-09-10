import assert from 'node:assert/strict';
import test from 'node:test';

import type { MongoConnection } from '@releasedeck/db';
import {
  createLogger,
  DependencyError,
  errorForLog,
  type RedisConnection,
  type RuntimeEnvironment,
} from '@releasedeck/runtime';

import { startWorker } from './worker.js';

const environment: RuntimeEnvironment = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MONGODB_URI: 'mongodb://127.0.0.1/releasedeck',
  REDIS_URL: 'redis://127.0.0.1',
};

test('worker closes Mongo when Redis initialization fails', async () => {
  let mongoClosed = false;
  const mongo = {
    close: async () => {
      mongoClosed = true;
    },
  } as unknown as MongoConnection;

  await assert.rejects(
    startWorker(environment, {
      connectMongo: async () => mongo,
      connectRedis: async () => {
        throw new Error('redis unavailable');
      },
      logger: createLogger('silent'),
    }),
    (error: unknown) => {
      assert.ok(error instanceof DependencyError);
      assert.deepEqual(errorForLog(error), {
        name: 'DependencyError',
        dependency: 'redis',
      });
      return true;
    },
  );
  assert.equal(mongoClosed, true);
});

test('worker closes both initialized connections once', async () => {
  let mongoCloses = 0;
  let redisCloses = 0;
  const mongo = {
    close: async () => {
      mongoCloses += 1;
    },
  } as unknown as MongoConnection;
  const redis = {
    close: async () => {
      redisCloses += 1;
    },
  } as unknown as RedisConnection;
  const worker = await startWorker(environment, {
    connectMongo: async () => mongo,
    connectRedis: async () => redis,
    logger: createLogger('silent'),
  });
  await Promise.all([worker.close(), worker.close()]);
  assert.equal(mongoCloses, 1);
  assert.equal(redisCloses, 1);
});
