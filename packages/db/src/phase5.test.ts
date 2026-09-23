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
  const complete = await deployments.recordReleaseSuccess(
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
