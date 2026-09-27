import {
  connectMongo,
  initializeDomainRepositories,
  type DeploymentRepositoryWithCiAndRelease,
} from '@releasedeck/db';
import { rollbackRelease } from '@releasedeck/release-deployer';
import {
  createLogger,
  errorForLog,
  loadAppEnvironment,
  parseWorkerEnvironment,
} from '@releasedeck/runtime';

import { processManualRollback } from './manual-rollback.js';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseArguments(args: readonly string[]): {
  activeDeploymentId: string;
  targetDeploymentId: string;
} {
  if (
    args.length !== 4 ||
    args[0] !== '--active' ||
    args[2] !== '--target' ||
    !uuid.test(args[1] ?? '') ||
    !uuid.test(args[3] ?? '') ||
    args[1] === args[3]
  ) {
    throw new Error(
      'usage: pnpm rollback --active <deployment-uuid> --target <deployment-uuid>',
    );
  }
  return { activeDeploymentId: args[1]!, targetDeploymentId: args[3]! };
}

loadAppEnvironment();
const logger = createLogger();
let mongo: Awaited<ReturnType<typeof connectMongo>> | undefined;
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

try {
  const { activeDeploymentId, targetDeploymentId } = parseArguments(
    process.argv.slice(2),
  );
  const environment = parseWorkerEnvironment();
  mongo = await connectMongo(environment.MONGODB_URI);
  const repositories = await initializeDomainRepositories(mongo.db);
  const deployment = await processManualRollback(
    activeDeploymentId,
    targetDeploymentId,
    {
      deployments: repositories.deployments as DeploymentRepositoryWithCiAndRelease,
    },
    { rollbackRelease },
    {
      leaseMs: environment.RELEASE_LEASE_MS,
      retention: environment.RELEASE_RETENTION,
      signal: controller.signal,
      target: {
        host: environment.RELEASE_SSH_HOST,
        port: environment.RELEASE_SSH_PORT,
        user: environment.RELEASE_SSH_USER,
        privateKeyPath: environment.RELEASE_SSH_PRIVATE_KEY_PATH,
        knownHostsPath: environment.RELEASE_SSH_KNOWN_HOSTS_PATH,
        remoteRoot: environment.RELEASE_REMOTE_ROOT,
        timeoutMs: environment.RELEASE_TIMEOUT_MS,
        outputLimitBytes: environment.RELEASE_MAX_OUTPUT_BYTES,
        healthUrl: environment.RELEASE_HEALTH_URL,
        healthAttempts: environment.RELEASE_HEALTH_ATTEMPTS,
        healthIntervalMs: environment.RELEASE_HEALTH_INTERVAL_MS,
        healthRequestTimeoutMs: environment.RELEASE_HEALTH_REQUEST_TIMEOUT_MS,
      },
    },
  );
  logger.info(
    { activeDeploymentId, targetDeploymentId, status: deployment.status },
    'manual rollback completed',
  );
  if (deployment.release?.manualRollback?.status !== 'RESTORED') process.exitCode = 1;
} catch (error) {
  logger.error({ error: errorForLog(error) }, 'manual rollback failed');
  process.exitCode = 1;
} finally {
  await mongo?.close().catch((error: unknown) => {
    logger.error(
      { error: errorForLog(error) },
      'manual rollback MongoDB cleanup failed',
    );
    process.exitCode = 1;
  });
}
