import { Redis, type RedisOptions } from 'ioredis';

import { DependencyError } from './logger.js';

export interface RedisConnection {
  readonly client: Redis;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface RedisConnectionOptions {
  connectTimeoutMs?: number;
}

export async function connectRedis(
  url: string,
  options: RedisConnectionOptions = {},
): Promise<RedisConnection> {
  const redisOptions: RedisOptions = {
    lazyConnect: true,
    connectTimeout: options.connectTimeoutMs ?? 5_000,
    commandTimeout: options.connectTimeoutMs ?? 5_000,
    maxRetriesPerRequest: 1,
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
