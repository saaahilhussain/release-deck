import {
  connectMongo,
  initializeDomainRepositories,
  type DeploymentRepositoryWithCiAndRelease,
  type DomainRepositories,
  type MongoConnection,
} from '@releasedeck/db';
import {
  createCiRunner,
  createGitHubAppAuth,
  createSystemdBuildExecutor,
  type BuildExecutor,
  type CiRunner,
  type GitHubAppAuth,
  type GitHubAppConfiguration,
} from '@releasedeck/ci-runner';
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
  type WorkerEnvironment,
} from '@releasedeck/runtime';
import {
  promoteRelease,
  cleanupPreparedRelease,
  openPreparedRelease,
  prepareRelease,
  stageRelease,
} from '@releasedeck/release-deployer';

import { processDeploymentJob, type DeploymentReleaseOperations } from './processor.js';

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
    options: { readonly concurrency: number },
  ): DeploymentWorker;
  createCiRunner?: typeof createCiRunner;
  createBuildExecutor?: (launcherPath: string) => BuildExecutor;
  createGitHubAppAuth?: (config: GitHubAppConfiguration) => Promise<GitHubAppAuth>;
  releaseOperations?: DeploymentReleaseOperations;
  logger: Logger;
}

export async function startWorker(
  environment: WorkerEnvironment,
  dependencies: WorkerStartupDependencies = {
    connectMongo,
    initializeDomainRepositories,
    connectRedis,
    createDeploymentWorker: (connection, processor, options) =>
      createQueueWorker(connection, processor, options),
    createCiRunner,
    logger: createLogger(environment.LOG_LEVEL),
  },
): Promise<WorkerRuntime> {
  let mongo: MongoConnection | undefined;
  let redis: RedisConnection | undefined;
  let repositories: DomainRepositories | undefined;
  let deploymentWorker: DeploymentWorker | undefined;
  try {
    // Probe before connecting/consuming. A missing or unsafe boundary never falls
    // back to same-user execution, even when startWorker is called directly.
    if (
      environment.NODE_ENV === 'production' &&
      environment.CI_EXECUTION_MODE !== 'systemd'
    ) {
      throw new Error('production worker requires isolated build execution');
    }
    let buildExecutor: BuildExecutor | undefined;
    if (environment.CI_EXECUTION_MODE === 'systemd') {
      if (environment.CI_CONCURRENCY !== 1)
        throw new Error('isolated builds require concurrency one');
      buildExecutor = (dependencies.createBuildExecutor ?? createSystemdBuildExecutor)(
        environment.CI_BUILD_LAUNCHER_PATH,
      );
      await buildExecutor.probe();
    }
    let githubAppAuth: GitHubAppAuth | undefined;
    const appFields = [
      environment.GITHUB_APP_ID,
      environment.GITHUB_APP_INSTALLATION_ID,
      environment.GITHUB_APP_PRIVATE_KEY_PATH,
    ];
    if (appFields.some((value) => value !== undefined)) {
      if (!buildExecutor)
        throw new Error('GitHub App checkout requires isolated build execution');
      if (
        !environment.GITHUB_APP_ID ||
        !environment.GITHUB_APP_INSTALLATION_ID ||
        !environment.GITHUB_APP_PRIVATE_KEY_PATH
      ) {
        throw new Error('GitHub App configuration is incomplete');
      }
      githubAppAuth = await (dependencies.createGitHubAppAuth ?? createGitHubAppAuth)({
        appId: environment.GITHUB_APP_ID,
        installationId: environment.GITHUB_APP_INSTALLATION_ID,
        privateKeyPath: environment.GITHUB_APP_PRIVATE_KEY_PATH,
      });
    }
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
    const runner: CiRunner = (dependencies.createCiRunner ?? createCiRunner)({
      workspaceRoot: environment.CI_WORKSPACE_ROOT,
      ...(buildExecutor ? { buildExecutor } : {}),
      ...(githubAppAuth ? { githubAppAuth } : {}),
      limits: {
        checkoutTimeoutMs: environment.CI_STEP_TIMEOUT_MS,
        installTimeoutMs: environment.CI_STEP_TIMEOUT_MS,
        testTimeoutMs: environment.CI_STEP_TIMEOUT_MS,
        buildTimeoutMs: environment.CI_STEP_TIMEOUT_MS,
        totalTimeoutMs: environment.CI_TOTAL_TIMEOUT_MS,
        outputLimitBytes: environment.CI_MAX_OUTPUT_BYTES,
      },
    });
    const releaseOperations: DeploymentReleaseOperations =
      dependencies.releaseOperations ?? {
        prepareRelease,
        openPreparedRelease,
        stageRelease,
        promoteRelease,
        cleanupPreparedRelease,
      };
    const processJob: DeploymentJobProcessor = (job, context) =>
      processDeploymentJob(
        job,
        context,
        {
          deployments:
            connectedRepositories.deployments as DeploymentRepositoryWithCiAndRelease,
          projects: connectedRepositories.projects,
        },
        runner,
        releaseOperations,
        {
          leaseMs: environment.CI_LEASE_MS,
          release: {
            artifactRoot: environment.RELEASE_ARTIFACT_ROOT,
            leaseMs: environment.RELEASE_LEASE_MS,
            retention: environment.RELEASE_RETENTION,
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
        },
      );
    deploymentWorker = (
      dependencies.createDeploymentWorker ??
      ((connection, processor, options) =>
        createQueueWorker(connection, processor, options))
    )(connectedRedis.client, processJob, {
      concurrency: environment.CI_CONCURRENCY,
    });
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
