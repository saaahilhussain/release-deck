import assert from 'node:assert/strict';
import test from 'node:test';

import type { DomainRepositories, MongoConnection } from '@releasedeck/db';
import type { DeploymentQueue } from '@releasedeck/queue';
import {
  createLogger,
  DependencyError,
  errorForLog,
  type ApiEnvironment,
} from '@releasedeck/runtime';

import { startApi, startPendingWebhookReconciler } from './server.js';

const environment: ApiEnvironment = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  HOST: '127.0.0.1',
  PORT: 31_111,
  MONGODB_URI: 'mongodb://127.0.0.1/releasedeck',
  REDIS_URL: 'redis://127.0.0.1',
  GITHUB_WEBHOOK_SECRET: 'phase-3-test-secret',
  OPERATOR_ID: 'operator',
  OPERATOR_PASSWORD_HASH:
    'scrypt$v1$N=65536,r=8,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  OPERATOR_ORIGIN: 'http://127.0.0.1:5173',
};

function queueStub(overrides: Partial<DeploymentQueue> = {}): DeploymentQueue {
  return {
    name: 'releasedeck-deployments',
    waitUntilReady: async () => undefined,
    enqueueDeployment: async () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}

test('startup closes Mongo when Redis initialization fails', async () => {
  let mongoClosed = false;
  const mongo = {
    ping: async () => undefined,
    close: async () => {
      mongoClosed = true;
    },
  } as unknown as MongoConnection;

  await assert.rejects(
    startApi(environment, {
      connectMongo: async () => mongo,
      initializeDomainRepositories: async () => ({}) as DomainRepositories,
      connectRedis: async () => {
        throw new Error('redis unavailable');
      },
      createDeploymentQueue: () => queueStub(),
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

test('startup closes Mongo and does not connect Redis when indexes fail', async () => {
  let mongoClosed = false;
  let redisConnected = false;
  const mongo = {
    ping: async () => undefined,
    close: async () => {
      mongoClosed = true;
    },
  } as unknown as MongoConnection;

  await assert.rejects(
    startApi(environment, {
      connectMongo: async () => mongo,
      initializeDomainRepositories: async () => {
        throw new Error('index details must remain private');
      },
      connectRedis: async () => {
        redisConnected = true;
        throw new Error('must not be called');
      },
      createDeploymentQueue: () => queueStub(),
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
  assert.equal(redisConnected, false);
});

test('startup closes queue, Redis, and Mongo when queue readiness fails', async () => {
  const closed: string[] = [];
  const mongo = {
    db: {},
    ping: async () => undefined,
    close: async () => {
      closed.push('mongo');
    },
  } as unknown as MongoConnection;
  const redis = {
    client: {},
    ping: async () => undefined,
    close: async () => {
      closed.push('redis');
    },
  } as never;

  await assert.rejects(
    startApi(environment, {
      connectMongo: async () => mongo,
      initializeDomainRepositories: async () => ({}) as DomainRepositories,
      connectRedis: async () => redis,
      createDeploymentQueue: () =>
        queueStub({
          waitUntilReady: async () => {
            throw new Error('queue unavailable');
          },
          close: async () => {
            closed.push('queue');
          },
        }),
      logger: createLogger('silent'),
    }),
    (error: unknown) =>
      error instanceof DependencyError && error.dependency === 'redis',
  );
  assert.deepEqual(closed, ['queue', 'redis', 'mongo']);
});

test('successful API shutdown closes the queue before shared connections', async () => {
  const closed: string[] = [];
  const mongo = {
    db: {},
    ping: async () => undefined,
    close: async () => {
      closed.push('mongo');
    },
  } as unknown as MongoConnection;
  const redis = {
    client: {},
    ping: async () => undefined,
    close: async () => {
      closed.push('redis');
    },
  } as never;
  const repositories = {
    webhookEvents: { listPending: async () => [] },
  } as unknown as DomainRepositories;
  const started = await startApi(
    { ...environment, PORT: 0 },
    {
      connectMongo: async () => mongo,
      initializeDomainRepositories: async () => repositories,
      connectRedis: async () => redis,
      createDeploymentQueue: () =>
        queueStub({
          close: async () => {
            closed.push('queue');
          },
        }),
      logger: createLogger('silent'),
    },
  );

  await started.close();
  assert.deepEqual(closed, ['queue', 'redis', 'mongo']);
});

test('reconciliation shutdown has a bounded wait', async () => {
  const never = new Promise<number>(() => undefined);
  const reconciler = startPendingWebhookReconciler(
    { reconcilePending: () => never } as never,
    createLogger('silent'),
    60_000,
    20,
  );
  const startedAt = Date.now();
  await reconciler.close();
  assert.ok(Date.now() - startedAt < 500);
});
