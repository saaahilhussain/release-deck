import { setTimeout as delay } from 'node:timers/promises';

import {
  ConcurrencyError,
  type CiCleanupStatus,
  type CiFailure,
  type CiStage,
  type CiStepOutcomeInput,
  type Deployment,
  type DeploymentRepositoryWithCi,
  type ProjectRepository,
} from '@releasedeck/db';
import {
  CiCleanupError,
  CiStepError,
  ProcessCancelledError,
  ProcessTimeoutError,
  type CiRunner,
  type CiStageResult,
} from '@releasedeck/ci-runner';
import type { DeploymentJobContext, DeploymentJobData } from '@releasedeck/queue';

export interface DeploymentProcessorRepositories {
  readonly deployments: Pick<
    DeploymentRepositoryWithCi,
    | 'findById'
    | 'claimCiExecution'
    | 'reclaimExpiredCiExecution'
    | 'renewCiExecution'
    | 'recordCiStepOutcome'
  >;
  readonly projects: Pick<ProjectRepository, 'findById'>;
}

export interface DeploymentProcessorOptions {
  readonly leaseMs: number;
  readonly now?: () => Date;
  readonly activeLeasePollMs?: number;
}

interface OwnedExecution {
  readonly attemptId: string;
  readonly fence: number;
  deployment: Deployment;
}

const CI_STAGES = new Set<CiStage>(['CHECKOUT', 'INSTALL', 'TEST', 'BUILD']);

function isFinished(deployment: Deployment): boolean {
  return (
    deployment.status === 'SUCCESS' ||
    deployment.status === 'FAILED' ||
    deployment.status === 'ROLLED_BACK' ||
    deployment.ci?.status === 'PASSED'
  );
}

function githubRepositoryUrl(owner: string, repository: string): string {
  return `https://github.com/${owner}/${repository}.git`;
}

async function acquireExecution(
  deploymentId: string,
  repositories: DeploymentProcessorRepositories,
  options: DeploymentProcessorOptions,
  signal: AbortSignal | undefined,
): Promise<OwnedExecution | null> {
  const now = options.now ?? (() => new Date());
  const pollMs = options.activeLeasePollMs ?? 1_000;
  for (;;) {
    const deployment = await repositories.deployments.findById(deploymentId);
    if (!deployment || isFinished(deployment)) return null;

    if (deployment.ci?.status === 'RUNNING') {
      const expiresAt = deployment.ci.leaseExpiresAt;
      if (expiresAt && expiresAt.valueOf() <= now().valueOf()) {
        try {
          const claim = await repositories.deployments.reclaimExpiredCiExecution(
            deploymentId,
            { leaseMs: options.leaseMs, now: now() },
          );
          if (claim) {
            return {
              attemptId: claim.attemptId,
              fence: claim.fence,
              deployment: claim.deployment,
            };
          }
        } catch (error) {
          if (!(error instanceof ConcurrencyError)) throw error;
        }
        continue;
      }

      const currentTime = now().valueOf();
      const remaining = Math.max(
        1,
        (expiresAt?.valueOf() ?? currentTime) - currentTime,
      );
      await delay(Math.min(pollMs, remaining), undefined, { signal });
      continue;
    }

    try {
      const claim = await repositories.deployments.claimCiExecution(deploymentId, {
        leaseMs: options.leaseMs,
        now: now(),
      });
      if (claim) {
        return {
          attemptId: claim.attemptId,
          fence: claim.fence,
          deployment: claim.deployment,
        };
      }
    } catch (error) {
      if (!(error instanceof ConcurrencyError)) throw error;
    }

    const current = await repositories.deployments.findById(deploymentId);
    if (!current || isFinished(current)) return null;
  }
}

function resultFromError(stage: CiStage, error: unknown): CiStageResult | undefined {
  if (error instanceof CiCleanupError) {
    return resultFromError(stage, error.executionError);
  }
  if (error instanceof CiStepError) return error.result;
  if (error instanceof ProcessTimeoutError || error instanceof ProcessCancelledError) {
    return { ...error.result, stage };
  }
  return undefined;
}

function failureKind(stage: CiStage, error: unknown): CiFailure['kind'] {
  if (error instanceof CiCleanupError) return 'WORKSPACE_FAILED';
  if (error instanceof ProcessTimeoutError) return 'COMMAND_TIMEOUT';
  if (error instanceof ProcessCancelledError) return 'CANCELLED';
  if (!(error instanceof CiStepError)) return 'SPAWN_FAILED';
  return `${stage}_FAILED` as CiFailure['kind'];
}

function canRetry(
  stage: CiStage,
  error: unknown,
  context: DeploymentJobContext,
): boolean {
  const attemptsRemain = context.attemptsMade + 1 < context.maxAttempts;
  if (!attemptsRemain) return false;
  if (error instanceof CiCleanupError) return true;
  if (error instanceof ProcessTimeoutError || error instanceof ProcessCancelledError) {
    return true;
  }
  if (!(error instanceof CiStepError)) return true;
  if (error.result === undefined) return false;
  if (stage === 'CHECKOUT') {
    return error.message !== 'checked out revision did not match requested SHA';
  }
  return stage === 'INSTALL';
}

function failureFor(
  stage: CiStage,
  error: unknown,
  context: DeploymentJobContext,
): CiFailure {
  const result = resultFromError(stage, error);
  const kind = failureKind(stage, error);
  const messages: Record<CiFailure['kind'], string> = {
    CHECKOUT_FAILED: 'CI checkout failed',
    INSTALL_FAILED: 'CI install failed',
    TEST_FAILED: 'CI test failed',
    BUILD_FAILED: 'CI build failed',
    COMMAND_TIMEOUT: 'CI command timed out',
    SPAWN_FAILED: 'CI command could not start',
    WORKSPACE_FAILED: 'CI workspace setup failed',
    LEASE_LOST: 'CI execution lease was lost',
    CANCELLED: 'CI command was cancelled',
  };
  return {
    kind,
    message:
      error instanceof CiCleanupError ? 'CI workspace cleanup failed' : messages[kind],
    retryable: canRetry(stage, error, context),
    ...(result?.exitCode === null || result?.exitCode === undefined
      ? {}
      : { exitCode: result.exitCode }),
    ...(result?.signal === null || result?.signal === undefined
      ? {}
      : { signal: result.signal }),
  };
}

function outcomeFor(
  owned: OwnedExecution,
  stage: CiStage,
  startedAt: Date,
  finishedAt: Date,
  result: CiStageResult | undefined,
  failure: CiFailure | undefined,
  cleanupStatus: CiCleanupStatus | undefined,
): CiStepOutcomeInput {
  const durationMs = Math.max(
    0,
    Math.min(
      86_400_000,
      result?.durationMs ?? finishedAt.valueOf() - startedAt.valueOf(),
    ),
  );
  return {
    expectedVersion: owned.deployment.version,
    attemptId: owned.attemptId,
    fence: owned.fence,
    stage,
    status:
      failure === undefined
        ? 'PASSED'
        : failure.kind === 'COMMAND_TIMEOUT'
          ? 'TIMED_OUT'
          : 'FAILED',
    startedAt,
    finishedAt,
    durationMs,
    stdout: result?.stdout ?? '',
    stderr: result?.stderr ?? '',
    stdoutTruncated: result?.stdoutTruncated ?? false,
    stderrTruncated: result?.stderrTruncated ?? false,
    ...(failure === undefined ? {} : { failure }),
    ...(cleanupStatus === undefined
      ? {}
      : { cleanup: { status: cleanupStatus, completedAt: finishedAt } }),
  };
}

/** Execute one authoritative deployment job through the Phase 4 CI boundary. */
export async function processDeploymentJob(
  job: DeploymentJobData,
  context: DeploymentJobContext,
  repositories: DeploymentProcessorRepositories,
  runner: CiRunner,
  options: DeploymentProcessorOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const owned = await acquireExecution(
    job.deploymentId,
    repositories,
    options,
    context.signal,
  );
  if (!owned) return;

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (context.signal?.aborted) controller.abort();
  else context.signal?.addEventListener('abort', forwardAbort, { once: true });
  let mutation = Promise.resolve();
  let stopped = false;
  let persistenceFailure: unknown;
  let renewalFailure: unknown;
  let observedFailure: { readonly stage: CiStage; readonly error: unknown } | undefined;
  let completedBuild: CiStageResult | undefined;
  let runnerInvoked = false;
  const stageStarted = new Map<CiStage, Date>();

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutation.then(operation);
    mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const persist = async (
    stage: CiStage,
    result: CiStageResult | undefined,
    failure: CiFailure | undefined,
    cleanupStatus?: CiCleanupStatus,
  ): Promise<void> => {
    const finishedAt = now();
    const startedAt =
      stageStarted.get(stage) ??
      new Date(finishedAt.valueOf() - Math.max(0, result?.durationMs ?? 0));
    try {
      owned.deployment = await serialize(() =>
        repositories.deployments.recordCiStepOutcome(
          job.deploymentId,
          outcomeFor(
            owned,
            stage,
            startedAt,
            finishedAt,
            result,
            failure,
            cleanupStatus,
          ),
          finishedAt,
        ),
      );
    } catch (error) {
      persistenceFailure = error;
      controller.abort();
      throw error;
    }
  };

  const heartbeat = async (): Promise<void> => {
    if (stopped || owned.deployment.ci?.status !== 'RUNNING') return;
    try {
      owned.deployment = await serialize(() =>
        repositories.deployments.renewCiExecution(
          job.deploymentId,
          {
            expectedVersion: owned.deployment.version,
            attemptId: owned.attemptId,
            fence: owned.fence,
            leaseMs: options.leaseMs,
          },
          now(),
        ),
      );
    } catch (error) {
      renewalFailure = error;
      controller.abort();
    }
  };

  const heartbeatTimer = setInterval(
    () => void heartbeat(),
    Math.max(1_000, Math.floor(options.leaseMs / 3)),
  );
  heartbeatTimer.unref();

  try {
    const project = await repositories.projects.findById(owned.deployment.projectId);
    if (!project) {
      stageStarted.set('CHECKOUT', now());
      await persist(
        'CHECKOUT',
        undefined,
        {
          kind: 'CHECKOUT_FAILED',
          message: 'deployment project was not found',
          retryable: false,
        },
        'CLEANED',
      );
      return;
    }

    runnerInvoked = true;
    await runner.run(
      {
        deploymentId: job.deploymentId,
        repositoryUrl: githubRepositoryUrl(project.owner, project.repository),
        commitSha: owned.deployment.commitSha,
        signal: controller.signal,
      },
      {
        onStageStarted(stage) {
          stageStarted.set(stage, now());
        },
        async onStageCompleted(result) {
          if (result.stage === 'BUILD') completedBuild = result;
          else await persist(result.stage, result, undefined);
        },
        onStageFailed(stage, error) {
          observedFailure = { stage, error };
        },
      },
    );
    if (!completedBuild) throw new Error('CI runner returned without a build result');
    await persist('BUILD', completedBuild, undefined, 'CLEANED');
  } catch (error) {
    if (persistenceFailure) throw persistenceFailure;
    if (renewalFailure) throw renewalFailure;
    if (!runnerInvoked) throw error;
    const stage = observedFailure?.stage ?? owned.deployment.stage;
    const ciStage = CI_STAGES.has(stage as CiStage) ? (stage as CiStage) : 'CHECKOUT';
    const cleanupFailed = error instanceof CiCleanupError;
    const reportedError = cleanupFailed ? error : (observedFailure?.error ?? error);
    const result =
      cleanupFailed && completedBuild
        ? completedBuild
        : resultFromError(ciStage, reportedError);
    const workspaceSetupFailed =
      observedFailure === undefined && stageStarted.size === 0;
    await persist(
      ciStage,
      result,
      cleanupFailed || workspaceSetupFailed
        ? {
            kind: 'WORKSPACE_FAILED',
            message: cleanupFailed
              ? 'CI workspace cleanup failed'
              : 'CI workspace setup failed',
            retryable: canRetry(ciStage, reportedError, context),
          }
        : failureFor(ciStage, reportedError, context),
      cleanupFailed ? 'FAILED' : 'CLEANED',
    );
    if (owned.deployment.ci?.status === 'RETRY_PENDING') throw error;
    if (owned.deployment.status === 'FAILED') return;
    throw error;
  } finally {
    stopped = true;
    clearInterval(heartbeatTimer);
    context.signal?.removeEventListener('abort', forwardAbort);
    await mutation;
  }
}
