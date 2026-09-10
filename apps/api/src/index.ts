import { connectMongo, initializeDomainRepositories } from '@releasedeck/db';
import {
  connectRedis,
  createLogger,
  errorForLog,
  loadAppEnvironment,
  parseApiEnvironment,
} from '@releasedeck/runtime';

import { installShutdownHandlers, startApi } from './server.js';

loadAppEnvironment();

let logger = createLogger();
try {
  const environment = parseApiEnvironment();
  logger = createLogger(environment.LOG_LEVEL);
  const started = await startApi(environment, {
    connectMongo,
    connectRedis,
    initializeDomainRepositories,
    logger,
  });
  installShutdownHandlers(started, logger);
  const address = started.server.address();
  logger.info(
    {
      address: typeof address === 'string' ? address : address?.address,
      port: typeof address === 'string' ? undefined : address?.port,
    },
    'api started',
  );
} catch (error) {
  logger.fatal({ error: errorForLog(error) }, 'api startup failed');
  process.exitCode = 1;
}
