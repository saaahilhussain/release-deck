import assert from 'node:assert/strict';
import test from 'node:test';

import type { DomainRepositories, MongoConnection } from '@releasedeck/db';
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

function repositories(): DomainRepositories {
  return {
    projects: {} as DomainRepositories['projects'],
    deployments: {} as DomainRepositories['deployments'],
    webhookEvents: {} as DomainRepositories['webhookEvents'],
  };
}

function workerStub(close: () => Promise<void>) {
  return {
    waitUntilReady: async () => undefined,
    close,
  };
}

test('worker closes Mongo when domain repository initialization fails', async () => {
  let mongoClosed = false;
  const mongo = {
    db: {},
    close: async () => {
      mongoClosed = true;
    },
  } as unknown as MongoConnection;

  await assert.rejects(
    startWorker(environment, {
      connectMongo: async () => mongo,
      initializeDomainRepositories: async () => {
        throw new Error('index initialization failed');
      },
      connectRedis: async () => {
        throw new Error('must not connect Redis');
      },
      logger: createLogger('silent'),
    }),
    (error: unknown) => {
      assert.ok(error instanceof DependencyError);
      assert.deepEqual(errorForLog(error), {
        name: 'DependencyError',
        dependency: 'mongodb',
      });
      return true;
    },
  );
  assert.equal(mongoClosed, true);
});

test('worker closes Mongo when Redis initialization fails', async () => {
  let mongoClosed = false;
  const mongo = {
    db: {},
    close: async () => {
      mongoClosed = true;
    },
  } as unknown as MongoConnection;

  await assert.rejects(
    startWorker(environment, {
      connectMongo: async () => mongo,
      initializeDomainRepositories: async () => repositories(),
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

test('worker uses BullMQ-safe Redis retry and blocking-command settings', async () => {
  let redisOptions:
    | {
        commandTimeoutMs?: number | null;
        maxRetriesPerRequest?: number | null;
      }
    | undefined;
  let workerCloses = 0;
  let redisCloses = 0;
  let mongoCloses = 0;
  const mongo = {
    db: {},
    close: async () => {
      mongoCloses += 1;
    },
  } as unknown as MongoConnection;
  const redis = {
    client: {},
    close: async () => {
      redisCloses += 1;
    },
  } as unknown as RedisConnection;
  const worker = await startWorker(environment, {
    connectMongo: async () => mongo,
    initializeDomainRepositories: async () => repositories(),
    connectRedis: async (_url, options) => {
      redisOptions = options;
      return redis;
    },
    createDeploymentWorker: () =>
      workerStub(async () => {
        workerCloses += 1;
      }),
    logger: createLogger('silent'),
  });
  assert.deepEqual(redisOptions, {
    commandTimeoutMs: null,
    maxRetriesPerRequest: null,
  });
  await Promise.all([worker.close(), worker.close()]);
  assert.equal(workerCloses, 1);
  assert.equal(redisCloses, 1);
  assert.equal(mongoCloses, 1);
});

test('worker closes the queue consumer before Redis and Mongo', async () => {
  const events: string[] = [];
  const mongo = {
    db: {},
    close: async () => {
      events.push('mongo');
    },
  } as unknown as MongoConnection;
  const redis = {
    client: {},
    close: async () => {
      events.push('redis');
    },
  } as unknown as RedisConnection;
  const worker = await startWorker(environment, {
    connectMongo: async () => mongo,
    initializeDomainRepositories: async () => repositories(),
    connectRedis: async () => redis,
    createDeploymentWorker: () =>
      workerStub(async () => {
        events.push('worker');
      }),
    logger: createLogger('silent'),
  });
  await worker.close();
  assert.deepEqual(events, ['worker', 'redis', 'mongo']);
});
