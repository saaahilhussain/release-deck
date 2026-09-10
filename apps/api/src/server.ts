import type { Server } from 'node:http';

import {
  connectMongo,
  initializeDomainRepositories,
  type DomainRepositories,
  type MongoConnection,
} from '@releasedeck/db';
import {
  connectRedis,
  createLogger,
  DependencyError,
  errorForLog,
  type ApiEnvironment,
  type Logger,
  type RedisConnection,
} from '@releasedeck/runtime';

import { createApp } from './app.js';

export interface ApiServices {
  mongo: MongoConnection;
  redis: RedisConnection;
  repositories: DomainRepositories;
}

export interface StartedApi {
  readonly server: Server;
  readonly services: ApiServices;
  close(): Promise<void>;
}

export interface ApiStartupDependencies {
  connectMongo(uri: string): Promise<MongoConnection>;
  connectRedis(url: string): Promise<RedisConnection>;
  initializeDomainRepositories(db: MongoConnection['db']): Promise<DomainRepositories>;
  logger: Logger;
}

export async function startApi(
  environment: ApiEnvironment,
  dependencies: ApiStartupDependencies = {
    connectMongo,
    connectRedis,
    initializeDomainRepositories,
    logger: createLogger(environment.LOG_LEVEL),
  },
): Promise<StartedApi> {
  let mongo: MongoConnection | undefined;
  let redis: RedisConnection | undefined;
  let repositories: DomainRepositories | undefined;
  let server: Server | undefined;

  try {
    mongo = await dependencies
      .connectMongo(environment.MONGODB_URI)
      .catch((error: unknown) => {
        throw new DependencyError('mongodb', error);
      });
    repositories = await dependencies
      .initializeDomainRepositories(mongo.db)
      .catch((error: unknown) => {
        throw new DependencyError('mongodb', error);
      });
    redis = await dependencies
      .connectRedis(environment.REDIS_URL)
      .catch((error: unknown) => {
        throw error instanceof DependencyError
          ? error
          : new DependencyError('redis', error);
      });
    const app = createApp({
      mongo,
      redis,
      repositories,
      logger: dependencies.logger,
    });

    server = app.listen(environment.PORT, environment.HOST);
    await new Promise<void>((resolve, reject) => {
      const listeningServer = server!;
      const cleanup = () => {
        listeningServer.off('listening', onListening);
        listeningServer.off('error', onError);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      listeningServer.once('listening', onListening);
      listeningServer.once('error', onError);
    });
    server.on('error', (error) => {
      dependencies.logger.error({ error: errorForLog(error) }, 'api server error');
    });

    const startedServer = server;
    const connectedMongo = mongo;
    const connectedRedis = redis;
    let closing: Promise<void> | undefined;
    return {
      server: startedServer,
      services: {
        mongo: connectedMongo,
        redis: connectedRedis,
        repositories,
      },
      close() {
        closing ??= closeApi(startedServer, connectedRedis, connectedMongo);
        return closing;
      },
    };
  } catch (error) {
    if (server) await closeServer(server);
    if (redis) await redis.close().catch(() => undefined);
    if (mongo) await mongo.close().catch(() => undefined);
    throw error;
  }
}

async function closeServer(server: Server, drainTimeoutMs = 5_000): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, drainTimeoutMs);
    timer.unref();
    server.close((error) => finish(error));
  });
}

async function closeApi(
  server: Server,
  redis: RedisConnection,
  mongo: MongoConnection,
): Promise<void> {
  const serverResult = await Promise.allSettled([closeServer(server)]);
  const connectionResults = await Promise.allSettled([redis.close(), mongo.close()]);
  const results = [...serverResult, ...connectionResults];
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}

export function installShutdownHandlers(started: StartedApi, logger: Logger): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'api shutting down');
    void started.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ error: errorForLog(error) }, 'api shutdown failed');
        process.exit(1);
      },
    );
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
