import {
  connectMongo,
  initializeDomainRepositories,
  type DomainRepositories,
  type MongoConnection,
} from '@releasedeck/db';
import {
  createDeploymentWorker as createQueueWorker,
  type DeploymentJobProcessor,
  type DeploymentWorker,
} from '@releasedeck/queue';
import {
  connectRedis,
  createLogger,
  DependencyError,
  type Logger,
  type RedisConnection,
  type RedisConnectionOptions,
  type RuntimeEnvironment,
} from '@releasedeck/runtime';

import { processDeploymentJob } from './processor.js';

export interface WorkerRuntime {
  readonly mongo: MongoConnection;
  readonly redis: RedisConnection;
  readonly repositories: DomainRepositories;
  readonly deploymentWorker: DeploymentWorker;
  close(): Promise<void>;
}

export interface WorkerStartupDependencies {
  connectMongo(uri: string): Promise<MongoConnection>;
  initializeDomainRepositories?(db: MongoConnection['db']): Promise<DomainRepositories>;
  connectRedis(url: string, options?: RedisConnectionOptions): Promise<RedisConnection>;
  createDeploymentWorker?(
    connection: RedisConnection['client'],
    processor: DeploymentJobProcessor,
  ): DeploymentWorker;
  logger: Logger;
}

export async function startWorker(
  environment: RuntimeEnvironment,
  dependencies: WorkerStartupDependencies = {
    connectMongo,
    initializeDomainRepositories,
    connectRedis,
    createDeploymentWorker: (connection, processor) =>
      createQueueWorker(connection, processor),
    logger: createLogger(environment.LOG_LEVEL),
  },
): Promise<WorkerRuntime> {
  let mongo: MongoConnection | undefined;
  let redis: RedisConnection | undefined;
  let repositories: DomainRepositories | undefined;
  let deploymentWorker: DeploymentWorker | undefined;
  try {
    mongo = await dependencies
      .connectMongo(environment.MONGODB_URI)
      .catch((error: unknown) => {
        throw new DependencyError('mongodb', error);
      });
    repositories = await (
      dependencies.initializeDomainRepositories ?? initializeDomainRepositories
    )(mongo.db).catch((error: unknown) => {
      throw new DependencyError('mongodb', error);
    });
    redis = await dependencies
      .connectRedis(environment.REDIS_URL, {
        commandTimeoutMs: null,
        maxRetriesPerRequest: null,
      })
      .catch((error: unknown) => {
        throw error instanceof DependencyError
          ? error
          : new DependencyError('redis', error);
      });

    const connectedMongo = mongo;
    const connectedRedis = redis;
    const connectedRepositories = repositories;
    const processJob: DeploymentJobProcessor = (job) =>
      processDeploymentJob(job, connectedRepositories.deployments);
    deploymentWorker = (
      dependencies.createDeploymentWorker ??
      ((connection, processor) => createQueueWorker(connection, processor))
    )(connectedRedis.client, processJob);
    await deploymentWorker.waitUntilReady();

    const connectedWorker = deploymentWorker;
    let closing: Promise<void> | undefined;
    return {
      mongo: connectedMongo,
      redis: connectedRedis,
      repositories: connectedRepositories,
      deploymentWorker: connectedWorker,
      close() {
        closing ??= closeConnections(connectedWorker, connectedRedis, connectedMongo);
        return closing;
      },
    };
  } catch (error) {
    if (deploymentWorker) await deploymentWorker.close().catch(() => undefined);
    if (redis) await redis.close().catch(() => undefined);
    if (mongo) await mongo.close().catch(() => undefined);
    throw error;
  }
}

async function closeConnections(
  deploymentWorker: DeploymentWorker,
  redis: RedisConnection,
  mongo: MongoConnection,
): Promise<void> {
  const workerResult = await Promise.allSettled([deploymentWorker.close()]);
  const connectionResults = await Promise.allSettled([redis.close(), mongo.close()]);
  const results = [...workerResult, ...connectionResults];
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}
