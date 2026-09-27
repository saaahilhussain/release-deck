import assert from 'node:assert/strict';
import test from 'node:test';

import type { DomainRepositories, MongoConnection } from '@releasedeck/db';
import {
  createLogger,
  DependencyError,
  errorForLog,
  type RedisConnection,
  type WorkerEnvironment,
} from '@releasedeck/runtime';

import { startWorker } from './worker.js';

const environment: WorkerEnvironment = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MONGODB_URI: 'mongodb://127.0.0.1/releasedeck',
  REDIS_URL: 'redis://127.0.0.1',
  RELEASE_SSH_HOST: 'target.example.com',
  RELEASE_HEALTH_URL: 'http://127.0.0.1:3000/health',
  RELEASE_HEALTH_ATTEMPTS: 5,
  RELEASE_HEALTH_INTERVAL_MS: 1000,
  RELEASE_HEALTH_REQUEST_TIMEOUT_MS: 2000,
  RELEASE_SSH_PORT: 22,
  RELEASE_SSH_USER: 'deployer',
  RELEASE_SSH_PRIVATE_KEY_PATH: 'D:\\releasedeck\\keys\\release-ed25519',
  RELEASE_SSH_KNOWN_HOSTS_PATH: 'D:\\releasedeck\\keys\\known_hosts',
  RELEASE_REMOTE_ROOT: '/srv/apps',
  RELEASE_ARTIFACT_ROOT: 'D:\\releasedeck\\artifacts',
  RELEASE_TIMEOUT_MS: 600_000,
  RELEASE_MAX_OUTPUT_BYTES: 65_536,
  RELEASE_LEASE_MS: 60_000,
  RELEASE_RETENTION: 5,
  CI_WORKSPACE_ROOT: 'D:\\releasedeck-test-workspaces',
  CI_STEP_TIMEOUT_MS: 5_000,
  CI_TOTAL_TIMEOUT_MS: 10_000,
  CI_MAX_OUTPUT_BYTES: 16_384,
  CI_LEASE_MS: 30_000,
  CI_CONCURRENCY: 2,
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
  let workerConcurrency: number | undefined;
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
    createDeploymentWorker: (_connection, _processor, options) => {
      workerConcurrency = options.concurrency;
      return workerStub(async () => {
        workerCloses += 1;
      });
    },
    logger: createLogger('silent'),
  });
  assert.deepEqual(redisOptions, {
    commandTimeoutMs: null,
    maxRetriesPerRequest: null,
  });
  assert.equal(workerConcurrency, 2);
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
