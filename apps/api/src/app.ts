import express, { type Express } from 'express';
import type { Logger } from '@releasedeck/runtime';

export interface HealthDependency {
  ping(): Promise<void>;
}

export interface AppDependencies {
  mongo: HealthDependency;
  redis: HealthDependency;
  logger: Logger;
  healthTimeoutMs?: number;
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', async (_request, response) => {
    const timeoutMs = dependencies.healthTimeoutMs ?? 3_000;
    const [mongo, redis] = await Promise.allSettled([
      withTimeout(dependencies.mongo.ping(), timeoutMs),
      withTimeout(dependencies.redis.ping(), timeoutMs),
    ]);
    const healthy = mongo.status === 'fulfilled' && redis.status === 'fulfilled';

    if (!healthy) {
      dependencies.logger.warn(
        {
          dependencies: {
            mongodb: mongo.status === 'fulfilled' ? 'available' : 'unavailable',
            redis: redis.status === 'fulfilled' ? 'available' : 'unavailable',
          },
        },
        'health check unavailable',
      );
    }

    response.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'unavailable',
      dependencies: {
        mongodb: mongo.status === 'fulfilled' ? 'available' : 'unavailable',
        redis: redis.status === 'fulfilled' ? 'available' : 'unavailable',
      },
    });
  });

  return app;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('dependency health check timed out')),
      timeoutMs,
    );
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
