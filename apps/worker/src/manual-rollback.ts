import {
  ConcurrencyError,
  type Deployment,
  type DeploymentRepositoryWithCiAndRelease,
  type ManualRollbackClaim,
  type ReleaseFailure,
  type ReleaseRollbackTarget,
} from '@releasedeck/db';
import {
  ReleaseDeployerError,
  type ManualRollbackInput,
  type RollbackOutcome,
  type SshTarget,
} from '@releasedeck/release-deployer';

export interface ManualRollbackRepositories {
  readonly deployments: Pick<
    DeploymentRepositoryWithCiAndRelease,
    | 'claimManualRollback'
    | 'reclaimExpiredManualRollback'
    | 'renewManualRollback'
    | 'recordManualRollbackOutcome'
    | 'recordManualRollbackFailure'
    | 'recordManualRollbackRejected'
  >;
}

export interface ManualRollbackOperations {
  rollbackRelease(input: ManualRollbackInput): Promise<RollbackOutcome>;
}

export interface ManualRollbackOptions {
  readonly leaseMs: number;
  readonly retention: number;
  readonly target: SshTarget;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

function rollbackTarget(
  projectId: string,
  deploymentId: string,
  commitSha: string,
  remoteRoot: string,
): ReleaseRollbackTarget {
  const releasePath = `${remoteRoot}/${projectId}/releases/${deploymentId}`;
  return {
    deploymentId,
    releaseId: deploymentId,
    commitSha,
    remoteReleasePath: releasePath,
    activeTarget: releasePath,
  };
}

function rollbackFailure(message: string): ReleaseFailure {
  return { kind: 'ROLLBACK_FAILED', message, retryable: false };
}

/** Operator-owned rollback to an already built, healthy release. */
export async function processManualRollback(
  activeDeploymentId: string,
  targetDeploymentId: string,
  repositories: ManualRollbackRepositories,
  operations: ManualRollbackOperations,
  options: ManualRollbackOptions,
): Promise<Deployment> {
  const now = options.now ?? (() => new Date());
  let claim: ManualRollbackClaim | null =
    await repositories.deployments.claimManualRollback(
      activeDeploymentId,
      targetDeploymentId,
      { now: now(), leaseMs: options.leaseMs },
    );
  if (!claim) {
    claim = await repositories.deployments.reclaimExpiredManualRollback(
      activeDeploymentId,
      targetDeploymentId,
      { now: now(), leaseMs: options.leaseMs },
    );
  }
  if (!claim) throw new ConcurrencyError('manual rollback is already in progress');
  if (claim.targetDeployment.id !== targetDeploymentId) {
    throw new ConcurrencyError('manual rollback target changed');
  }

  const owned = claim;
  let deployment = owned.deployment;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  let mutation = Promise.resolve();
  let stopped = false;
  let renewalFailure: unknown;
  const serialize = (
    operation: (current: Deployment) => Promise<Deployment>,
  ): Promise<Deployment> => {
    const result = mutation.then(async () => {
      const next = await operation(deployment);
      deployment = next;
      return next;
    });
    mutation = result.then(() => undefined);
    void mutation.catch(() => undefined);
    return result;
  };
  const stopHeartbeats = async (): Promise<void> => {
    stopped = true;
    clearInterval(heartbeatTimer);
    await mutation;
  };
  const heartbeat = async () => {
    if (stopped) return;
    try {
      await serialize((current) =>
        repositories.deployments.renewManualRollback(
          activeDeploymentId,
          {
            expectedVersion: current.version,
            requestId: owned.requestId,
            attemptId: owned.attemptId,
            fence: owned.fence,
            leaseMs: options.leaseMs,
          },
          now(),
        ),
      );
    } catch (error) {
      renewalFailure ??= error;
      stopped = true;
      clearInterval(heartbeatTimer);
      controller.abort();
    }
  };
  const heartbeatTimer = setInterval(
    () => void heartbeat(),
    Math.max(1_000, Math.floor(options.leaseMs / 3)),
  );
  heartbeatTimer.unref();

  try {
    let outcome: RollbackOutcome;
    let operationError: unknown;
    try {
      outcome = await operations.rollbackRelease({
        requestId: owned.requestId,
        projectId: deployment.projectId,
        deploymentId: activeDeploymentId,
        commitSha: deployment.commitSha,
        targetDeploymentId,
        targetCommitSha: owned.targetDeployment.commitSha,
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
      await stopHeartbeats();
    } catch (mutationError) {
      if (renewalFailure) throw renewalFailure;
      throw mutationError;
    }
    if (renewalFailure) throw renewalFailure;
    if (options.signal?.aborted) {
      throw operationError ?? new Error('manual rollback was cancelled');
    }
    const target = rollbackTarget(
      deployment.projectId,
      targetDeploymentId,
      owned.targetDeployment.commitSha,
      options.target.remoteRoot,
    );
    const token = (current: Deployment) => ({
      expectedVersion: current.version,
      requestId: owned.requestId,
      attemptId: owned.attemptId,
      fence: owned.fence,
      target,
    });
    if (operationError) {
      const rejected =
        operationError instanceof ReleaseDeployerError &&
        operationError.kind === 'remote' &&
        operationError.exitCode === 66;
      await serialize((current) =>
        (rejected
          ? repositories.deployments.recordManualRollbackRejected
          : repositories.deployments.recordManualRollbackFailure)(
          activeDeploymentId,
          {
            ...token(current),
            failure: rollbackFailure(
              rejected
                ? 'manual rollback precondition was rejected by the target'
                : 'manual rollback transport or remote proof failed',
            ),
          },
          now(),
        ),
      );
    } else if (outcome!.status === 'RESTORED') {
      await serialize((current) =>
        repositories.deployments.recordManualRollbackOutcome(
          activeDeploymentId,
          { ...token(current), health: outcome!.healthProof },
          now(),
        ),
      );
    } else {
      await serialize((current) =>
        repositories.deployments.recordManualRollbackFailure(
          activeDeploymentId,
          {
            ...token(current),
            failure: rollbackFailure(
              outcome!.status === 'FAILED_ACTIVE_RESTORED'
                ? 'manual rollback target was unhealthy; active release was restored'
                : 'manual rollback and active release recovery failed',
            ),
            ...(outcome!.status === 'FAILED_ACTIVE_RESTORED'
              ? { activeHealth: outcome!.healthProof }
              : {}),
          },
          now(),
        ),
      );
    }
    return deployment;
  } finally {
    stopped = true;
    clearInterval(heartbeatTimer);
    options.signal?.removeEventListener('abort', forwardAbort);
    await mutation;
  }
}
