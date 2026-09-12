import type { Server } from 'node:http';

import {
  connectMongo,
  initializeDomainRepositories,
  type DomainRepositories,
  type MongoConnection,
} from '@releasedeck/db';
import { createDeploymentQueue, type DeploymentQueue } from '@releasedeck/queue';
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
import { GithubWebhookProcessor } from './webhooks.js';

const WEBHOOK_RECONCILE_INTERVAL_MS = 5_000;
const WEBHOOK_RECONCILE_SHUTDOWN_MS = 5_000;

interface PendingWebhookReconciler {
  close(): Promise<void>;
}

export interface ApiServices {
  mongo: MongoConnection;
  redis: RedisConnection;
  repositories: DomainRepositories;
  deploymentQueue: DeploymentQueue;
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
  createDeploymentQueue(connection: RedisConnection['client']): DeploymentQueue;
  logger: Logger;
}

export async function startApi(
  environment: ApiEnvironment,
  dependencies: ApiStartupDependencies = {
    connectMongo,
    connectRedis,
    initializeDomainRepositories,
    createDeploymentQueue,
    logger: createLogger(environment.LOG_LEVEL),
  },
): Promise<StartedApi> {
  let mongo: MongoConnection | undefined;
  let redis: RedisConnection | undefined;
  let repositories: DomainRepositories | undefined;
  let deploymentQueue: DeploymentQueue | undefined;
  let reconciler: PendingWebhookReconciler | undefined;
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
    deploymentQueue = dependencies.createDeploymentQueue(redis.client);
    await deploymentQueue.waitUntilReady().catch((error: unknown) => {
      throw new DependencyError('redis', error);
    });
    const webhookProcessor = new GithubWebhookProcessor(repositories, {
      secret: environment.GITHUB_WEBHOOK_SECRET,
      queue: deploymentQueue,
    });
    reconciler = startPendingWebhookReconciler(webhookProcessor, dependencies.logger);
    const app = createApp({
      mongo,
      redis,
      repositories,
      logger: dependencies.logger,
      githubWebhookProcessor: webhookProcessor,
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
    const connectedQueue = deploymentQueue;
    const activeReconciler = reconciler;
    let closing: Promise<void> | undefined;
    return {
      server: startedServer,
      services: {
        mongo: connectedMongo,
        redis: connectedRedis,
        repositories,
        deploymentQueue: connectedQueue,
      },
      close() {
        closing ??= closeApi(
          startedServer,
          activeReconciler,
          connectedQueue,
          connectedRedis,
          connectedMongo,
        );
        return closing;
      },
    };
  } catch (error) {
    if (server) await closeServer(server);
    if (reconciler) await reconciler.close().catch(() => undefined);
    if (deploymentQueue) await deploymentQueue.close().catch(() => undefined);
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
  reconciler: PendingWebhookReconciler,
  deploymentQueue: DeploymentQueue,
  redis: RedisConnection,
  mongo: MongoConnection,
): Promise<void> {
  const serverResult = await Promise.allSettled([closeServer(server)]);
  const reconcilerResult = await Promise.allSettled([reconciler.close()]);
  const queueResult = await Promise.allSettled([deploymentQueue.close()]);
  const connectionResults = await Promise.allSettled([redis.close(), mongo.close()]);
  const results = [
    ...serverResult,
    ...reconcilerResult,
    ...queueResult,
    ...connectionResults,
  ];
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}

export function startPendingWebhookReconciler(
  processor: GithubWebhookProcessor,
  logger: Logger,
  intervalMs = WEBHOOK_RECONCILE_INTERVAL_MS,
  shutdownTimeoutMs = WEBHOOK_RECONCILE_SHUTDOWN_MS,
): PendingWebhookReconciler {
  let closed = false;
  let running: Promise<void> | undefined;
  const run = () => {
    if (closed || running) return;
    running = processor
      .reconcilePending()
      .then((processed) => {
        if (processed > 0) {
          logger.info({ processed }, 'pending webhook deliveries reconciled');
        }
      })
      .catch((error: unknown) => {
        logger.warn(
          { error: errorForLog(error) },
          'pending webhook reconciliation failed',
        );
      })
      .finally(() => {
        running = undefined;
      });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (!running) return;
      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        running,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            resolve();
          }, shutdownTimeoutMs);
          timeout.unref();
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        logger.warn('pending webhook reconciliation exceeded shutdown deadline');
      }
    },
  };
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
