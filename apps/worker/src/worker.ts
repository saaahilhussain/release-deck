import { connectMongo, type MongoConnection } from '@releasedeck/db';
import {
  connectRedis,
  createLogger,
  DependencyError,
  type Logger,
  type RedisConnection,
  type RuntimeEnvironment,
} from '@releasedeck/runtime';

export interface WorkerRuntime {
  readonly mongo: MongoConnection;
  readonly redis: RedisConnection;
  close(): Promise<void>;
}

export interface WorkerStartupDependencies {
  connectMongo(uri: string): Promise<MongoConnection>;
  connectRedis(url: string): Promise<RedisConnection>;
  logger: Logger;
}

export async function startWorker(
  environment: RuntimeEnvironment,
  dependencies: WorkerStartupDependencies = {
    connectMongo,
    connectRedis,
    logger: createLogger(environment.LOG_LEVEL),
  },
): Promise<WorkerRuntime> {
  let mongo: MongoConnection | undefined;
  let redis: RedisConnection | undefined;
  try {
    mongo = await dependencies
      .connectMongo(environment.MONGODB_URI)
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
    const connectedMongo = mongo;
    const connectedRedis = redis;
    let closing: Promise<void> | undefined;
    return {
      mongo: connectedMongo,
      redis: connectedRedis,
      close() {
        closing ??= closeConnections(connectedRedis, connectedMongo);
        return closing;
      },
    };
  } catch (error) {
    if (redis) await redis.close().catch(() => undefined);
    if (mongo) await mongo.close().catch(() => undefined);
    throw error;
  }
}

async function closeConnections(
  redis: RedisConnection,
  mongo: MongoConnection,
): Promise<void> {
  const results = await Promise.allSettled([redis.close(), mongo.close()]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}
