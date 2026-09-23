import { setTimeout as delay } from 'node:timers/promises';

import {
  ConcurrencyError,
  type Deployment,
  type DeploymentRepositoryWithCiAndRelease,
  type ReleaseExecutionClaim,
  type ReleaseFailure,
} from '@releasedeck/db';
import type { DeploymentJobContext } from '@releasedeck/queue';
import {
  ReleaseDeployerError,
  type PreparedRelease,
  type ReleaseProof,
  type SshTarget,
} from '@releasedeck/release-deployer';

export interface ReleaseOperations {
  openPreparedRelease(
    artifactRoot: string,
    expected: {
      readonly projectId: string;
      readonly deploymentId: string;
      readonly commitSha: string;
    },
  ): Promise<PreparedRelease>;
  stageRelease(input: {
    readonly projectId: string;
    readonly deploymentId: string;
    readonly commitSha: string;
    readonly attemptId: string;
    readonly artifact: PreparedRelease;
    readonly target: SshTarget;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  activateRelease(input: {
    readonly projectId: string;
    readonly deploymentId: string;
    readonly commitSha: string;
    readonly attemptId: string;
    readonly retention: number;
    readonly target: SshTarget;
    readonly signal?: AbortSignal;
    readonly now?: () => Date;
  }): Promise<ReleaseProof>;
  cleanupPreparedRelease(artifactRoot: string, deploymentId: string): Promise<void>;
}

export interface ReleaseProcessorRepositories {
  readonly deployments: Pick<
    DeploymentRepositoryWithCiAndRelease,
    | 'findById'
    | 'claimReleaseExecution'
    | 'reclaimExpiredReleaseExecution'
    | 'renewReleaseExecution'
    | 'recordReleaseSuccess'
    | 'recordReleaseFailure'
  >;
}

export interface ReleaseProcessorOptions {
  readonly artifactRoot: string;
  readonly leaseMs: number;
  readonly retention: number;
  readonly target: SshTarget;
  readonly now?: () => Date;
  readonly activeLeasePollMs?: number;
}

interface OwnedRelease {
  readonly attemptId: string;
  readonly fence: number;
  deployment: Deployment;
}

function terminal(deployment: Deployment): boolean {
  return (
    deployment.status === 'SUCCESS' ||
    deployment.status === 'FAILED' ||
    deployment.status === 'ROLLED_BACK'
  );
}

async function acquireRelease(
  deploymentId: string,
  repositories: ReleaseProcessorRepositories,
  options: ReleaseProcessorOptions,
  signal: AbortSignal | undefined,
): Promise<OwnedRelease | null> {
  const now = options.now ?? (() => new Date());
  const pollMs = options.activeLeasePollMs ?? 1_000;
  for (;;) {
    const deployment = await repositories.deployments.findById(deploymentId);
    if (!deployment || terminal(deployment)) return null;
    if (deployment.ci?.status !== 'PASSED') return null;

    if (deployment.release?.status === 'RUNNING') {
      const expiresAt = deployment.release.leaseExpiresAt;
      if (expiresAt && expiresAt.valueOf() <= now().valueOf()) {
        try {
          const claim = await repositories.deployments.reclaimExpiredReleaseExecution(
            deploymentId,
            { leaseMs: options.leaseMs, now: now() },
          );
          if (claim) return ownedRelease(claim);
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
      const claim = await repositories.deployments.claimReleaseExecution(deploymentId, {
        leaseMs: options.leaseMs,
        now: now(),
      });
      if (claim) return ownedRelease(claim);
    } catch (error) {
      if (!(error instanceof ConcurrencyError)) throw error;
    }

    const current = await repositories.deployments.findById(deploymentId);
    if (!current || terminal(current)) return null;
  }
}

function ownedRelease(claim: ReleaseExecutionClaim): OwnedRelease {
  return {
    attemptId: claim.attemptId,
    fence: claim.fence,
    deployment: claim.deployment,
  };
}

function releaseFailure(
  error: unknown,
  context: DeploymentJobContext,
  cancelled: boolean,
): ReleaseFailure {
  const attemptsRemain = context.attemptsMade + 1 < context.maxAttempts;
  if (cancelled) {
    return {
      kind: 'CANCELLED',
      message: 'release operation was cancelled',
      retryable: attemptsRemain,
    };
  }
  if (error instanceof ReleaseDeployerError) {
    let kind: ReleaseFailure['kind'];
    switch (error.kind) {
      case 'preparation':
      case 'cleanup':
        kind = 'PACKAGE_FAILED';
        break;
      case 'transport':
        kind = 'TRANSPORT_FAILED';
        break;
      case 'remote':
        kind = 'REMOTE_FAILED';
        break;
    }
    const message: string = {
      PACKAGE_FAILED: 'release artifact handling failed',
      TRANSPORT_FAILED: 'release transport failed',
      REMOTE_FAILED: 'remote release operation failed',
      LEASE_LOST: 'release execution lease was lost',
      CANCELLED: 'release operation was cancelled',
    }[kind];
    return {
      kind,
      message,
      retryable: attemptsRemain,
      ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
      ...(error.signal === undefined ? {} : { signal: error.signal }),
    };
  }
  return {
    kind: 'REMOTE_FAILED',
    message: 'remote release operation failed',
    retryable: attemptsRemain,
  };
}

/** Activate one already-staged immutable release under a fenced DB lease. */
export async function processReleaseDeployment(
  deploymentId: string,
  context: DeploymentJobContext,
  repositories: ReleaseProcessorRepositories,
  operations: ReleaseOperations,
  options: ReleaseProcessorOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const owned = await acquireRelease(
    deploymentId,
    repositories,
    options,
    context.signal,
  );
  if (!owned) {
    const current = await repositories.deployments.findById(deploymentId);
    if (current && terminal(current)) {
      await operations.cleanupPreparedRelease(options.artifactRoot, deploymentId);
    }
    return;
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (context.signal?.aborted) controller.abort();
  else context.signal?.addEventListener('abort', forwardAbort, { once: true });
  let mutation = Promise.resolve();
  let stopped = false;
  let renewalFailure: unknown;

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutation.then(operation);
    mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const heartbeat = async (): Promise<void> => {
    if (stopped || owned.deployment.release?.status !== 'RUNNING') return;
    try {
      owned.deployment = await serialize(() =>
        repositories.deployments.renewReleaseExecution(
          deploymentId,
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

  let operationError: unknown;
  let proof: ReleaseProof | undefined;
  try {
    const artifact = await operations.openPreparedRelease(options.artifactRoot, {
      projectId: owned.deployment.projectId,
      deploymentId,
      commitSha: owned.deployment.commitSha,
    });
    await operations.stageRelease({
      projectId: owned.deployment.projectId,
      deploymentId,
      commitSha: owned.deployment.commitSha,
      attemptId: owned.attemptId,
      artifact,
      target: options.target,
      signal: controller.signal,
    });
    proof = await operations.activateRelease({
      projectId: owned.deployment.projectId,
      deploymentId,
      commitSha: owned.deployment.commitSha,
      attemptId: owned.attemptId,
      retention: options.retention,
      target: options.target,
      signal: controller.signal,
      now,
    });
  } catch (error) {
    operationError = error;
  }

  try {
    if (renewalFailure) throw renewalFailure;
    if (operationError) {
      const failure = releaseFailure(
        operationError,
        context,
        controller.signal.aborted && !renewalFailure,
      );
      owned.deployment = await serialize(() =>
        repositories.deployments.recordReleaseFailure(
          deploymentId,
          {
            expectedVersion: owned.deployment.version,
            attemptId: owned.attemptId,
            fence: owned.fence,
            failure,
          },
          now(),
        ),
      );
      if (owned.deployment.release?.status === 'RETRY_PENDING') {
        throw operationError;
      }
      await operations.cleanupPreparedRelease(options.artifactRoot, deploymentId);
      return;
    }
    if (!proof) throw new Error('release activation returned no proof');
    owned.deployment = await serialize(() =>
      repositories.deployments.recordReleaseSuccess(
        deploymentId,
        {
          expectedVersion: owned.deployment.version,
          attemptId: owned.attemptId,
          fence: owned.fence,
          proof: {
            releaseId: proof.deploymentId,
            commitSha: proof.commitSha,
            remoteReleasePath: proof.remoteReleasePath,
            activeTarget: proof.activeTarget,
            pm2ProcessName: proof.pm2ProcessName,
            pm2Pid: proof.pm2Pid,
            nginx: proof.nginx,
            completedAt: proof.completedAt,
          },
        },
        now(),
      ),
    );
    await operations.cleanupPreparedRelease(options.artifactRoot, deploymentId);
  } finally {
    stopped = true;
    clearInterval(heartbeatTimer);
    context.signal?.removeEventListener('abort', forwardAbort);
    await mutation;
  }
}
