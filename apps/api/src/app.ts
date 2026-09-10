import express, { type ErrorRequestHandler, type Express } from 'express';
import { errorForLog, type Logger } from '@releasedeck/runtime';
import {
  ApiError,
  BadRequestError,
  ConflictError,
  isDuplicateError,
  isInvalidInputError,
  isNotFoundError,
  NotFoundError,
  PayloadTooLargeError,
} from './errors.js';
import { createApiRouter } from './routes.js';
import type { ApiRepositories } from './services.js';

export interface HealthDependency {
  ping(): Promise<void>;
}

export interface AppDependencies {
  mongo: HealthDependency;
  redis: HealthDependency;
  logger: Logger;
  healthTimeoutMs?: number;
  repositories?: ApiRepositories;
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

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

  if (dependencies.repositories) {
    app.use('/api', createApiRouter(dependencies.repositories));
  }

  app.use((_request, _response, next) => {
    next(new NotFoundError('route was not found'));
  });
  app.use(apiErrorHandler(dependencies.logger));

  return app;
}

function apiErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const parserError = error as { type?: unknown };
    if (parserError.type === 'entity.too.large') {
      error = new PayloadTooLargeError();
    } else if (parserError.type === 'entity.parse.failed') {
      error = new BadRequestError('malformed JSON');
    }

    if (!(error instanceof ApiError)) {
      if (isInvalidInputError(error)) error = new BadRequestError();
      else if (isNotFoundError(error)) error = new NotFoundError();
      else if (isDuplicateError(error)) error = new ConflictError();
    }

    if (error instanceof ApiError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields?.length ? { fields: error.fields } : {}),
        },
      });
      return;
    }

    logger.error({ error: errorForLog(error) }, 'api request failed');
    response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'internal server error' },
    });
  };
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
