import { Redis, type RedisOptions } from 'ioredis';

import { DependencyError } from './logger.js';

export interface RedisConnection {
  readonly client: Redis;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface RedisConnectionOptions {
  connectTimeoutMs?: number;
  /** Null disables ioredis command deadlines for BullMQ blocking consumers. */
  commandTimeoutMs?: number | null;
  maxRetriesPerRequest?: number | null;
}

export async function connectRedis(
  url: string,
  options: RedisConnectionOptions = {},
): Promise<RedisConnection> {
  const redisOptions: RedisOptions = {
    lazyConnect: true,
    connectTimeout: options.connectTimeoutMs ?? 5_000,
    ...(options.commandTimeoutMs === null
      ? {}
      : {
          commandTimeout: options.commandTimeoutMs ?? options.connectTimeoutMs ?? 5_000,
        }),
    maxRetriesPerRequest:
      options.maxRetriesPerRequest === undefined ? 1 : options.maxRetriesPerRequest,
    retryStrategy: () => null,
  };
  const client = new Redis(url, redisOptions);
  let connectionEventError: Error | undefined;

  // ioredis emits errors as events even when the command promise is handled.
  client.on('error', (error) => {
    connectionEventError ??= error;
  });

  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    client.disconnect(false);
    throw new DependencyError('redis', connectionEventError ?? error);
  }

  let closed = false;
  return {
    client,
    async ping() {
      await client.ping();
    },
    async close() {
      if (closed) return;
      closed = true;
      client.disconnect(false);
    },
  };
}
