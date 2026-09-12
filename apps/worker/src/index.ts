import { connectMongo } from '@releasedeck/db';
import {
  connectRedis,
  createLogger,
  errorForLog,
  loadAppEnvironment,
  parseRuntimeEnvironment,
} from '@releasedeck/runtime';

import { startWorker } from './worker.js';

loadAppEnvironment();

let logger = createLogger();
try {
  const environment = parseRuntimeEnvironment();
  logger = createLogger(environment.LOG_LEVEL);
  const worker = await startWorker(environment, { connectMongo, connectRedis, logger });
  logger.info('worker connected and consuming deployment jobs');
  const idleTimer = setInterval(() => undefined, 60_000);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(idleTimer);
    logger.info({ signal }, 'worker shutting down');
    void worker.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ error: errorForLog(error) }, 'worker shutdown failed');
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  logger.fatal({ error: errorForLog(error) }, 'worker startup failed');
  process.exitCode = 1;
}
