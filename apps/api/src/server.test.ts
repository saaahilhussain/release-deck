import assert from 'node:assert/strict';
import test from 'node:test';

import type { DomainRepositories, MongoConnection } from '@releasedeck/db';
import {
  createLogger,
  DependencyError,
  errorForLog,
  type ApiEnvironment,
} from '@releasedeck/runtime';

import { startApi } from './server.js';

const environment: ApiEnvironment = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  HOST: '127.0.0.1',
  PORT: 31_111,
  MONGODB_URI: 'mongodb://127.0.0.1/releasedeck',
  REDIS_URL: 'redis://127.0.0.1',
};

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
