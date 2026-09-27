import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOMAIN_INDEXES,
  CI_STAGES,
  ConcurrencyError,
  ValidationError,
  assertReleaseExecutionState,
  createDomainRepositories,
  type CiStage,
  type DeploymentRepositoryWithCiAndRelease,
  type DeploymentReleaseExecution,
} from './index.js';

type Stored = Record<string, unknown> & { _id: string };

function pathValue(document: Stored, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, document);
}

function matches(document: Stored, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = pathValue(document, key);
    if (expected && typeof expected === 'object') {
      const condition = expected as Record<string, unknown>;
      if ('$exists' in condition && condition.$exists !== (actual !== undefined)) {
        return false;
      }
      if (
        '$lte' in condition &&
        !((actual as Date).valueOf() <= (condition.$lte as Date).valueOf())
      ) {
        return false;
      }
      if (
        '$gt' in condition &&
        !((actual as Date).valueOf() > (condition.$gt as Date).valueOf())
      ) {
        return false;
      }
      return true;
    }
    return actual === expected;
  });
}

class FakeCollection {
  readonly documents: Stored[] = [];
  beforeUpdate: (() => void) | undefined;

  async insertOne(document: Stored): Promise<void> {
    this.documents.push({ ...document });
  }

  async findOne(filter: Record<string, unknown>): Promise<Stored | null> {
    return this.documents.find((item) => matches(item, filter)) ?? null;
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
  ) {
    this.beforeUpdate?.();
    const item = this.documents.find((candidate) => matches(candidate, filter));
    if (!item) return { matchedCount: 0 };
    Object.assign(item, update.$set ?? {});
    for (const [key, value] of Object.entries(update.$inc ?? {})) {
      item[key] = Number(item[key]) + Number(value);
    }
    return { matchedCount: 1 };
  }

  find() {
    const chain = {
      sort: () => chain,
      limit: () => chain,
      toArray: async () => this.documents,
    };
    return chain;
  }
}

function repositories() {
  const collections = new Map<string, FakeCollection>();
  const db = {
    collection(name: string) {
      const collection = collections.get(name) ?? new FakeCollection();
      collections.set(name, collection);
      return collection;
    },
  };
  const domain = createDomainRepositories(db as never);
  return {
    deployments: domain.deployments as DeploymentRepositoryWithCiAndRelease,
    collections,
  };
}

const deploymentId = '01234567-89ab-4cde-8012-3456789abcde';
const sha = '0123456789abcdef0123456789abcdef01234567';
const attemptId = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-09-21T00:00:00.000Z');

function running(): DeploymentReleaseExecution {
  return {
    status: 'RUNNING',
    releaseId: deploymentId,
    attemptNumber: 1,
    fence: 1,
    attemptId,
    leaseExpiresAt: new Date(now.valueOf() + 60_000),
    heartbeatAt: now,
    startedAt: now,
  };
}

test('release execution validates deterministic identity and bounded terminal proof', () => {
  assert.doesNotThrow(() =>
    assertReleaseExecutionState(deploymentId, sha, 'RUNNING', 'DEPLOY', running()),
  );
  const base = { ...running() } as {
    -readonly [K in keyof DeploymentReleaseExecution]?: DeploymentReleaseExecution[K];
  };
  delete base.leaseExpiresAt;
  delete base.heartbeatAt;
  delete base.failure;
  const deployed = {
    ...base,
    releaseId: deploymentId,
    attemptNumber: 1,
    fence: 1,
    status: 'DEPLOYED' as const,
    finishedAt: now,
    success: {
      releaseId: deploymentId,
      commitSha: sha,
      remoteReleasePath: '/srv/app/releases/01234567-89ab-4cde-8012-3456789abcde',
      activeTarget: '/srv/app/releases/01234567-89ab-4cde-8012-3456789abcde',
      pm2ProcessName: `releasedeck-${deploymentId}`,
      pm2Pid: 123,
      nginx: { validated: true, reloaded: true },
      completedAt: now,
    },
  } as DeploymentReleaseExecution;
  assert.doesNotThrow(() =>
    assertReleaseExecutionState(deploymentId, sha, 'SUCCESS', 'COMPLETE', deployed),
  );
  assert.throws(
    () =>
      assertReleaseExecutionState(deploymentId, sha, 'SUCCESS', 'COMPLETE', {
        ...deployed,
        success: { ...deployed.success!, commitSha: 'f'.repeat(40) },
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      assertReleaseExecutionState(deploymentId, sha, 'SUCCESS', 'COMPLETE', {
        ...deployed,
        success: null,
      } as never),
    ValidationError,
  );
});

test('release lease index is declared and retryable failures are bounded', () => {
  assert.ok(
    DOMAIN_INDEXES.deployments.some(
      (index) => index.name === 'deployments_release_lease_expiry',
    ),
  );
  const retryBase = { ...running() } as {
    -readonly [K in keyof DeploymentReleaseExecution]?: DeploymentReleaseExecution[K];
  };
  delete retryBase.leaseExpiresAt;
  delete retryBase.heartbeatAt;
  assert.throws(
    () =>
      assertReleaseExecutionState(deploymentId, sha, 'RUNNING', 'DEPLOY', {
        ...retryBase,
        releaseId: deploymentId,
        attemptNumber: 1,
        fence: 1,
        status: 'RETRY_PENDING',
        failure: { kind: 'TRANSPORT_FAILED', message: 'retry', retryable: false },
      }),
    ValidationError,
  );
});

function ciStep(stage: CiStage) {
  return {
    stage,
    status: 'PASSED' as const,
    startedAt: now,
    finishedAt: new Date(now.valueOf() + 10),
    durationMs: 10,
    exitCode: 0,
    signal: null,
    ...(stage === 'BUILD'
      ? {
          cleanup: {
            status: 'CLEANED' as const,
            completedAt: new Date(now.valueOf() + 10),
          },
        }
      : {}),
  };
}

async function passedCi(deployments: DeploymentRepositoryWithCiAndRelease) {
  const deployment = await deployments.createQueued({ projectId, commitSha: sha });
  const ci = await deployments.claimCiExecution(deployment.id, {
    now,
    leaseMs: 10_000,
  });
  assert.ok(ci);
  let current = ci.deployment;
  for (const stage of CI_STAGES) {
    const result = ciStep(stage);
    current = await deployments.recordCiStepOutcome(
      deployment.id,
      {
        expectedVersion: current.version,
        attemptId: ci.attemptId,
        fence: ci.fence,
        ...result,
      },
      new Date(now.valueOf() + 20),
    );
  }
  return current;
}

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('release claims are exclusive and expired attempts are fenced on reclaim', async () => {
  const { deployments } = repositories();
  const deployment = await passedCi(deployments);
  const claims = await Promise.all([
    deployments.claimReleaseExecution(deployment.id, { now, leaseMs: 10_000 }),
    deployments.claimReleaseExecution(deployment.id, { now, leaseMs: 10_000 }),
  ]);
  const first = claims.find((claim) => claim !== null);
  assert.ok(first);
  assert.equal(claims.filter((claim) => claim !== null).length, 1);
  assert.equal(first.deployment.stage, 'DEPLOY');

  const reclaimed = await deployments.reclaimExpiredReleaseExecution(deployment.id, {
    now: new Date(now.valueOf() + 10_001),
    leaseMs: 10_000,
  });
  assert.ok(reclaimed);
  assert.equal(reclaimed.fence, first.fence + 1);
  await assert.rejects(
    deployments.recordReleaseFailure(
      deployment.id,
      {
        expectedVersion: reclaimed.deployment.version,
        attemptId: first.attemptId,
        fence: first.fence,
        failure: {
          kind: 'TRANSPORT_FAILED',
          message: 'stale failure',
          retryable: false,
        },
      },
      new Date(now.valueOf() + 10_002),
    ),
    ConcurrencyError,
  );
});

test('release retry and success preserve CI evidence and persist bounded proof', async () => {
  const { deployments } = repositories();
  const deployment = await passedCi(deployments);
  const first = await deployments.claimReleaseExecution(deployment.id, {
    now,
    leaseMs: 10_000,
  });
  assert.ok(first);
  const pending = await deployments.recordReleaseFailure(
    deployment.id,
    {
      expectedVersion: first.deployment.version,
      attemptId: first.attemptId,
      fence: first.fence,
      failure: {
        kind: 'TRANSPORT_FAILED',
        message: 'temporary network failure',
        retryable: true,
      },
    },
    new Date(now.valueOf() + 1),
  );
  assert.equal(pending.release?.status, 'RETRY_PENDING');
  const retry = await deployments.claimReleaseExecution(deployment.id, {
    now: new Date(now.valueOf() + 2),
    leaseMs: 10_000,
  });
  assert.ok(retry);
  const completedAt = new Date(now.valueOf() + 3);
  const remoteReleasePath = `/srv/apps/${projectId}/releases/${deployment.id}`;
  const complete = await deployments.recordReleasePromotion(
    deployment.id,
    {
      expectedVersion: retry.deployment.version,
      attemptId: retry.attemptId,
      fence: retry.fence,
      proof: {
        releaseId: deployment.id,
        commitSha: sha,
        remoteReleasePath,
        activeTarget: remoteReleasePath,
        pm2ProcessName: `releasedeck-${projectId}`,
        pm2Pid: 42,
        nginx: { validated: true, reloaded: true },
        completedAt,
      },
      health: {
        url: 'http://127.0.0.1:3000/healthz',
        statusCode: 200,
        attempts: 1,
        completedAt,
      },
    },
    completedAt,
  );
  assert.equal(complete.status, 'SUCCESS');
  assert.equal(complete.stage, 'COMPLETE');
  assert.equal(complete.ci?.status, 'PASSED');
  assert.equal(complete.release?.status, 'DEPLOYED');
});

test('release renewal rechecks expiry in the atomic update filter', async () => {
  const { deployments, collections } = repositories();
  const deployment = await passedCi(deployments);
  const claim = await deployments.claimReleaseExecution(deployment.id, {
    now,
    leaseMs: 10_000,
  });
  assert.ok(claim);
  const collection = collections.get('deployments')!;
  const stored = collection.documents.find((item) => item._id === deployment.id)!;
  collection.beforeUpdate = () => {
    const release = stored.release as Record<string, unknown>;
    release.leaseExpiresAt = new Date(now.valueOf() - 1);
  };
  await assert.rejects(
    deployments.renewReleaseExecution(
      deployment.id,
      {
        expectedVersion: claim.deployment.version,
        attemptId: claim.attemptId,
        fence: claim.fence,
        leaseMs: 10_000,
      },
      new Date(now.valueOf() + 1),
    ),
    ConcurrencyError,
  );
});

const health = {
  url: 'http://127.0.0.1:3000/healthz',
  statusCode: 200,
  attempts: 1,
  completedAt: now,
};
function releaseProof(id: string, commitSha: string, project: string) {
  const remoteReleasePath = `/srv/apps/${project}/releases/${id}`;
  return {
    releaseId: id,
    commitSha,
    remoteReleasePath,
    activeTarget: remoteReleasePath,
    pm2ProcessName: `releasedeck-${project}`,
    pm2Pid: 42,
    nginx: { validated: true, reloaded: true },
    completedAt: now,
  };
}

test('Phase 6 promotes only with health proof and durably records A restored after B fails health', async () => {
  const { deployments } = repositories();
  const prior = await passedCi(deployments);
  const priorClaim = await deployments.claimReleaseExecution(prior.id, {
    now,
    leaseMs: 10_000,
  });
  assert.ok(priorClaim);
  const healthyA = await deployments.recordReleasePromotion(
    prior.id,
    {
      expectedVersion: priorClaim.deployment.version,
      attemptId: priorClaim.attemptId,
      fence: priorClaim.fence,
      proof: releaseProof(prior.id, sha, projectId),
      health,
    },
    now,
  );
  assert.equal(healthyA.release?.health?.statusCode, 200);

  const candidate = await passedCi(deployments);
  const claim = await deployments.claimReleaseExecution(candidate.id, {
    now,
    leaseMs: 10_000,
  });
  assert.ok(claim);
  const checking = await deployments.advanceReleaseStage(
    candidate.id,
    {
      expectedVersion: claim.deployment.version,
      attemptId: claim.attemptId,
      fence: claim.fence,
      stage: 'HEALTH_CHECK',
    },
    now,
  );
  const rollingBack = await deployments.advanceReleaseStage(
    candidate.id,
    {
      expectedVersion: checking.version,
      attemptId: claim.attemptId,
      fence: claim.fence,
      stage: 'ROLLBACK',
    },
    now,
  );
  const restored = await deployments.recordReleaseRollback(
    candidate.id,
    {
      expectedVersion: rollingBack.version,
      attemptId: claim.attemptId,
      fence: claim.fence,
      target: {
        deploymentId: prior.id,
        releaseId: prior.id,
        commitSha: sha,
        remoteReleasePath: healthyA.release!.success!.remoteReleasePath,
        activeTarget: healthyA.release!.success!.activeTarget,
      },
      health,
    },
    now,
  );
  assert.equal(restored.status, 'ROLLED_BACK');
  assert.equal(restored.stage, 'ROLLBACK');
  assert.equal(
    restored.release?.success,
    undefined,
    'candidate B must not receive fabricated success evidence',
  );
  assert.equal(restored.release?.rollback?.target.deploymentId, prior.id);
  assert.equal(
    (await deployments.findById(candidate.id))?.release?.rollback?.outcome,
    'RESTORED',
  );

  const failedCandidate = await passedCi(deployments);
  const failedClaim = await deployments.claimReleaseExecution(failedCandidate.id, {
    now,
    leaseMs: 10_000,
  });
  assert.ok(failedClaim);
  const failedChecking = await deployments.advanceReleaseStage(
    failedCandidate.id,
    {
      expectedVersion: failedClaim.deployment.version,
      attemptId: failedClaim.attemptId,
      fence: failedClaim.fence,
      stage: 'HEALTH_CHECK',
    },
    now,
  );
  const failedRollbackStage = await deployments.advanceReleaseStage(
    failedCandidate.id,
    {
      expectedVersion: failedChecking.version,
      attemptId: failedClaim.attemptId,
      fence: failedClaim.fence,
      stage: 'ROLLBACK',
    },
    now,
  );
  const rollbackFailed = await deployments.recordReleaseRollbackFailure(
    failedCandidate.id,
    {
      expectedVersion: failedRollbackStage.version,
      attemptId: failedClaim.attemptId,
      fence: failedClaim.fence,
      attemptedTarget: {
        deploymentId: prior.id,
        releaseId: prior.id,
        commitSha: sha,
        remoteReleasePath: healthyA.release!.success!.remoteReleasePath,
        activeTarget: healthyA.release!.success!.activeTarget,
      },
      failure: {
        kind: 'ROLLBACK_FAILED',
        message: 'restored release did not become healthy',
        retryable: false,
      },
    },
    now,
  );
  assert.equal(rollbackFailed.status, 'FAILED');
  assert.equal(rollbackFailed.stage, 'ROLLBACK');
  assert.equal(rollbackFailed.release?.rollback?.outcome, 'FAILED');
  assert.equal(rollbackFailed.release?.success, undefined);
});

test('manual rollback claims only a healthy same-project predecessor and fences completion', async () => {
  const { deployments } = repositories();
  const prior = await passedCi(deployments);
  const priorClaim = await deployments.claimReleaseExecution(prior.id, {
    now,
    leaseMs: 10_000,
  });
  assert.ok(priorClaim);
  const healthyA = await deployments.recordReleasePromotion(
    prior.id,
    {
      expectedVersion: priorClaim.deployment.version,
      attemptId: priorClaim.attemptId,
      fence: priorClaim.fence,
      proof: releaseProof(prior.id, sha, projectId),
      health,
    },
    now,
  );
  const active = await passedCi(deployments);
  const activeClaim = await deployments.claimReleaseExecution(active.id, {
    now,
    leaseMs: 10_000,
  });
  assert.ok(activeClaim);
  const laterHealth = { ...health, completedAt: new Date(now.valueOf() + 5) };
  const healthyB = await deployments.recordReleasePromotion(
    active.id,
    {
      expectedVersion: activeClaim.deployment.version,
      attemptId: activeClaim.attemptId,
      fence: activeClaim.fence,
      proof: {
        ...releaseProof(active.id, sha, projectId),
        completedAt: laterHealth.completedAt,
      },
      health: laterHealth,
    },
    laterHealth.completedAt,
  );
  const rejectedClaim = await deployments.claimManualRollback(active.id, prior.id, {
    now: laterHealth.completedAt,
    leaseMs: 10_000,
  });
  assert.ok(rejectedClaim);
  const rejected = await deployments.recordManualRollbackRejected(
    active.id,
    {
      expectedVersion: rejectedClaim.deployment.version,
      requestId: rejectedClaim.requestId,
      attemptId: rejectedClaim.attemptId,
      fence: rejectedClaim.fence,
      target: {
        deploymentId: prior.id,
        releaseId: prior.id,
        commitSha: sha,
        remoteReleasePath: healthyA.release!.success!.remoteReleasePath,
        activeTarget: healthyA.release!.success!.activeTarget,
      },
      failure: {
        kind: 'ROLLBACK_FAILED',
        message: 'manual rollback precondition was rejected by the target',
        retryable: false,
      },
    },
    new Date(now.valueOf() + 6),
  );
  assert.equal(rejected.status, 'SUCCESS');
  assert.equal(rejected.stage, 'COMPLETE');
  assert.equal(rejected.release?.status, 'DEPLOYED');
  assert.equal(rejected.release?.manualRollback?.status, 'REJECTED');
  assertReleaseExecutionState(
    rejected.id,
    rejected.commitSha,
    rejected.status,
    rejected.stage,
    rejected.release,
  );
  const manual = await deployments.claimManualRollback(active.id, prior.id, {
    now: new Date(now.valueOf() + 7),
    leaseMs: 10_000,
  });
  assert.ok(manual);
  assert.equal(
    await deployments.reclaimExpiredManualRollback(
      active.id,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      { now: new Date(laterHealth.completedAt.valueOf() + 10_001) },
    ),
    null,
    'an expired request cannot be reclaimed for a different target',
  );
  const renewed = await deployments.renewManualRollback(
    active.id,
    {
      expectedVersion: manual.deployment.version,
      requestId: manual.requestId,
      attemptId: manual.attemptId,
      fence: manual.fence,
      leaseMs: 10_000,
    },
    new Date(now.valueOf() + 8),
  );
  const rolled = await deployments.recordManualRollbackOutcome(
    active.id,
    {
      expectedVersion: renewed.version,
      requestId: manual.requestId,
      attemptId: manual.attemptId,
      fence: manual.fence,
      target: {
        deploymentId: prior.id,
        releaseId: prior.id,
        commitSha: sha,
        remoteReleasePath: healthyA.release!.success!.remoteReleasePath,
        activeTarget: healthyA.release!.success!.activeTarget,
      },
      health,
    },
    new Date(now.valueOf() + 9),
  );
  assert.equal(rolled.status, 'ROLLED_BACK');
  assert.equal(rolled.release?.rollback?.mode, 'MANUAL');
  assert.equal(rolled.release?.success?.releaseId, active.id);
  assert.throws(
    () =>
      assertReleaseExecutionState(active.id, sha, rolled.status, rolled.stage, {
        ...rolled.release!,
        manualRollback: {
          ...rolled.release!.manualRollback!,
          targetDeploymentId: active.id,
        },
      }),
    ValidationError,
    'a persisted manual request cannot point back to its own deployment',
  );
  const reverse = await deployments.claimManualRollback(prior.id, active.id, {
    now: new Date(now.valueOf() + 10),
    leaseMs: 10_000,
  });
  assert.ok(reverse, 'a previously promoted release remains restorable');
  assert.equal(reverse.targetDeployment.status, 'ROLLED_BACK');
  const restoredB = await deployments.recordManualRollbackOutcome(
    prior.id,
    {
      expectedVersion: reverse.deployment.version,
      requestId: reverse.requestId,
      attemptId: reverse.attemptId,
      fence: reverse.fence,
      target: {
        deploymentId: active.id,
        releaseId: active.id,
        commitSha: sha,
        remoteReleasePath: healthyB.release!.success!.remoteReleasePath,
        activeTarget: healthyB.release!.success!.activeTarget,
      },
      health,
    },
    new Date(now.valueOf() + 11),
  );
  assert.equal(restoredB.release?.rollback?.target.deploymentId, active.id);

  const candidateC = await passedCi(deployments);
  const claimC = await deployments.claimReleaseExecution(candidateC.id, {
    now: new Date(now.valueOf() + 12),
    leaseMs: 10_000,
  });
  assert.ok(claimC);
  const checkingC = await deployments.advanceReleaseStage(
    candidateC.id,
    {
      expectedVersion: claimC.deployment.version,
      attemptId: claimC.attemptId,
      fence: claimC.fence,
      stage: 'HEALTH_CHECK',
    },
    new Date(now.valueOf() + 10),
  );
  const rollbackC = await deployments.advanceReleaseStage(
    candidateC.id,
    {
      expectedVersion: checkingC.version,
      attemptId: claimC.attemptId,
      fence: claimC.fence,
      stage: 'ROLLBACK',
    },
    new Date(now.valueOf() + 10),
  );
  const restoredFromC = await deployments.recordReleaseRollback(
    candidateC.id,
    {
      expectedVersion: rollbackC.version,
      attemptId: claimC.attemptId,
      fence: claimC.fence,
      target: {
        deploymentId: active.id,
        releaseId: active.id,
        commitSha: sha,
        remoteReleasePath: healthyB.release!.success!.remoteReleasePath,
        activeTarget: healthyB.release!.success!.activeTarget,
      },
      health,
    },
    new Date(now.valueOf() + 10),
  );
  assert.equal(restoredFromC.release?.rollback?.target.deploymentId, active.id);
  assert.equal(restoredFromC.status, 'ROLLED_BACK');
  await assert.rejects(
    deployments.claimManualRollback(healthyB.id, active.id, { now }),
    ValidationError,
  );
});

test('unhealthy candidate without a predecessor records NO_KNOWN_GOOD at HEALTH_CHECK', async () => {
  const { deployments } = repositories();
  const candidate = await passedCi(deployments);
  const claim = await deployments.claimReleaseExecution(candidate.id, {
    now,
    leaseMs: 10_000,
  });
  assert.ok(claim);
  const checking = await deployments.advanceReleaseStage(
    candidate.id,
    {
      expectedVersion: claim.deployment.version,
      attemptId: claim.attemptId,
      fence: claim.fence,
      stage: 'HEALTH_CHECK',
    },
    now,
  );
  const failed = await deployments.recordReleaseFailure(
    candidate.id,
    {
      expectedVersion: checking.version,
      attemptId: claim.attemptId,
      fence: claim.fence,
      failure: {
        kind: 'NO_KNOWN_GOOD',
        message: 'candidate unhealthy and no previous healthy release exists',
        retryable: false,
      },
    },
    now,
  );
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.stage, 'HEALTH_CHECK');
  assert.equal(failed.release?.failure?.kind, 'NO_KNOWN_GOOD');
});

test('release failure after health-check entry preserves the terminal stage and resets retry stage', async () => {
  const { deployments } = repositories();
  const candidate = await passedCi(deployments);
  const claim = await deployments.claimReleaseExecution(candidate.id, {
    now,
    leaseMs: 10_000,
  });
  assert.ok(claim);
  const checking = await deployments.advanceReleaseStage(
    candidate.id,
    {
      expectedVersion: claim.deployment.version,
      attemptId: claim.attemptId,
      fence: claim.fence,
      stage: 'HEALTH_CHECK',
    },
    now,
  );
  const retry = await deployments.recordReleaseFailure(
    candidate.id,
    {
      expectedVersion: checking.version,
      attemptId: claim.attemptId,
      fence: claim.fence,
      failure: {
        kind: 'TRANSPORT_FAILED',
        message: 'remote result was not received',
        retryable: true,
      },
    },
    now,
  );
  assert.equal(retry.stage, 'DEPLOY');
  assert.equal(retry.release?.status, 'RETRY_PENDING');
  const second = await deployments.claimReleaseExecution(candidate.id, {
    now: new Date(now.valueOf() + 1),
    leaseMs: 10_000,
  });
  assert.ok(second);
  const secondChecking = await deployments.advanceReleaseStage(
    candidate.id,
    {
      expectedVersion: second.deployment.version,
      attemptId: second.attemptId,
      fence: second.fence,
      stage: 'HEALTH_CHECK',
    },
    new Date(now.valueOf() + 1),
  );
  const failed = await deployments.recordReleaseFailure(
    candidate.id,
    {
      expectedVersion: secondChecking.version,
      attemptId: second.attemptId,
      fence: second.fence,
      failure: {
        kind: 'TRANSPORT_FAILED',
        message: 'remote result was not received',
        retryable: false,
      },
    },
    new Date(now.valueOf() + 1),
  );
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.stage, 'HEALTH_CHECK');
  assert.equal(failed.release?.failure?.kind, 'TRANSPORT_FAILED');
});

test('manual rollback failure preserves B as successful when B is re-proven healthy', async () => {
  const { deployments } = repositories();
  const prior = await passedCi(deployments);
  const priorClaim = await deployments.claimReleaseExecution(prior.id, {
    now,
    leaseMs: 10_000,
  });
  assert.ok(priorClaim);
  const healthyA = await deployments.recordReleasePromotion(
    prior.id,
    {
      expectedVersion: priorClaim.deployment.version,
      attemptId: priorClaim.attemptId,
      fence: priorClaim.fence,
      proof: releaseProof(prior.id, sha, projectId),
      health,
    },
    now,
  );
  const active = await passedCi(deployments);
  const releaseClaim = await deployments.claimReleaseExecution(active.id, {
    now,
    leaseMs: 10_000,
  });
  assert.ok(releaseClaim);
  const laterHealth = { ...health, completedAt: new Date(now.valueOf() + 5) };
  const healthyB = await deployments.recordReleasePromotion(
    active.id,
    {
      expectedVersion: releaseClaim.deployment.version,
      attemptId: releaseClaim.attemptId,
      fence: releaseClaim.fence,
      proof: {
        ...releaseProof(active.id, sha, projectId),
        completedAt: laterHealth.completedAt,
      },
      health: laterHealth,
    },
    laterHealth.completedAt,
  );
  const request = await deployments.claimManualRollback(active.id, prior.id, {
    now: laterHealth.completedAt,
    leaseMs: 10_000,
  });
  assert.ok(request);
  const outcome = await deployments.recordManualRollbackFailure(
    active.id,
    {
      expectedVersion: request.deployment.version,
      requestId: request.requestId,
      attemptId: request.attemptId,
      fence: request.fence,
      target: {
        deploymentId: prior.id,
        releaseId: prior.id,
        commitSha: sha,
        remoteReleasePath: healthyA.release!.success!.remoteReleasePath,
        activeTarget: healthyA.release!.success!.activeTarget,
      },
      failure: {
        kind: 'ROLLBACK_FAILED',
        message: 'previous release could not be activated',
        retryable: false,
      },
      activeHealth: laterHealth,
    },
    laterHealth.completedAt,
  );
  assert.equal(outcome.status, 'SUCCESS');
  assert.equal(outcome.stage, 'COMPLETE');
  assert.equal(outcome.release?.status, 'DEPLOYED');
  assert.equal(outcome.release?.manualRollback?.status, 'FAILED');
  assert.equal(outcome.release?.rollback?.activeHealth?.statusCode, 200);
  assert.equal(outcome.release?.success?.releaseId, healthyB.id);
});
