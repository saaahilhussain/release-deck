import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CI_STAGES,
  ConcurrencyError,
  DOMAIN_INDEXES,
  MAX_CI_MESSAGE_BYTES,
  MAX_CI_OUTPUT_BYTES,
  PersistenceError,
  ValidationError,
  assertCiExecutionState,
  createCiStepResult,
  createDomainRepositories,
  type CiCleanupEvidence,
  type CiStage,
  type CiFailure,
  type DeploymentRepositoryWithCi,
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
      if ('$exists' in condition && condition.$exists !== (actual !== undefined))
        return false;
      if ('$in' in condition && !(condition.$in as unknown[]).includes(actual))
        return false;
      if (
        '$lte' in condition &&
        !((actual as Date).valueOf() <= (condition.$lte as Date).valueOf())
      )
        return false;
      if (
        '$gt' in condition &&
        !((actual as Date).valueOf() > (condition.$gt as Date).valueOf())
      )
        return false;
      return true;
    }
    return actual === expected;
  });
}

class FakeCollection {
  readonly documents: Stored[] = [];
  findFailure: unknown;
  updateFailure: unknown;
  beforeUpdate: (() => void) | undefined;

  async insertOne(document: Stored): Promise<void> {
    if (this.documents.some((item) => item._id === document._id)) throw { code: 11000 };
    this.documents.push({ ...document });
  }

  async findOne(filter: Record<string, unknown>): Promise<Stored | null> {
    if (this.findFailure !== undefined) throw this.findFailure;
    return this.documents.find((item) => matches(item, filter)) ?? null;
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
  ) {
    if (this.updateFailure !== undefined) throw this.updateFailure;
    this.beforeUpdate?.();
    const item = this.documents.find((candidate) => matches(candidate, filter));
    if (!item) return { matchedCount: 0 };
    Object.assign(item, update.$set ?? {});
    for (const [key, value] of Object.entries(update.$inc ?? {}))
      item[key] = Number(item[key]) + Number(value);
    return { matchedCount: 1 };
  }

  find(filter: Record<string, unknown>) {
    const selected = this.documents.filter((item) => matches(item, filter));
    let take = selected.length;
    let spec: Record<string, 1 | -1> = {};
    const chain = {
      sort: (value: Record<string, 1 | -1>) => {
        spec = value;
        return chain;
      },
      limit: (value: number) => {
        take = value;
        return chain;
      },
      toArray: async () =>
        [...selected]
          .sort((a, b) => {
            for (const [key, direction] of Object.entries(spec)) {
              const left = pathValue(a, key) as Date | string;
              const right = pathValue(b, key) as Date | string;
              const compared =
                left instanceof Date && right instanceof Date
                  ? left.valueOf() - right.valueOf()
                  : String(left).localeCompare(String(right));
              if (compared) return compared * direction;
            }
            return 0;
          })
          .slice(0, take),
    };
    return chain;
  }
}

function repositories() {
  const collections = new Map<string, FakeCollection>();
  const db = {
    collection(name: string) {
      const existing = collections.get(name) ?? new FakeCollection();
      collections.set(name, existing);
      return existing;
    },
  };
  const domain = createDomainRepositories(db as never);
  return {
    repositories: {
      ...domain,
      deployments: domain.deployments as DeploymentRepositoryWithCi,
    },
    collections,
  };
}

const projectId = '01234567-89ab-4cde-8012-3456789abcde';
const sha = '0123456789abcdef0123456789abcdef01234567';
const attemptId = '11111111-1111-4111-8111-111111111111';
const baseTime = new Date('2026-01-01T00:00:00.000Z');

function step(
  stage: CiStage,
  status: 'PASSED' | 'FAILED' | 'TIMED_OUT' = 'PASSED',
  failure?: CiFailure,
  cleanup?: CiCleanupEvidence,
) {
  return {
    stage,
    status,
    startedAt: baseTime,
    finishedAt: new Date(baseTime.valueOf() + 10),
    durationMs: 10,
    ...(failure === undefined ? {} : { failure }),
    ...(cleanup === undefined ? {} : { cleanup }),
  } as const;
}

const cleaned = {
  status: 'CLEANED',
  completedAt: new Date(baseTime.valueOf() + 10),
} as const;

test('CI domain enforces bounded output, contiguous steps, and state combinations', () => {
  const valid = createCiStepResult(attemptId, 1, step('CHECKOUT'));
  assert.equal(valid.stdout, '');
  assert.throws(
    () =>
      createCiStepResult(attemptId, 1, {
        ...step('CHECKOUT'),
        stdout: 'x'.repeat(MAX_CI_OUTPUT_BYTES + 1),
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      createCiStepResult(attemptId, 1, {
        ...step('CHECKOUT'),
        failure: {
          kind: 'TEST_FAILED',
          message: 'x'.repeat(MAX_CI_MESSAGE_BYTES + 1),
          retryable: false,
        },
        status: 'FAILED',
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      assertCiExecutionState('RUNNING', 'INSTALL', {
        status: 'RUNNING',
        attemptNumber: 1,
        fence: 1,
        attemptId,
        leaseExpiresAt: new Date(2),
        heartbeatAt: baseTime,
        startedAt: baseTime,
        stepResults: [valid, { ...valid, stage: 'TEST' }],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      createCiStepResult(attemptId, 1, {
        ...step('CHECKOUT', 'FAILED', {
          kind: 'INSTALL_FAILED',
          message: 'wrong stage',
          retryable: false,
        }),
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      createCiStepResult(attemptId, 1, {
        ...step('CHECKOUT', 'TIMED_OUT', {
          kind: 'CANCELLED',
          message: 'wrong timeout kind',
          retryable: false,
        }),
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      assertCiExecutionState('FAILED', 'CHECKOUT', {
        status: 'FAILED',
        attemptNumber: 1,
        fence: 1,
        attemptId,
        startedAt: baseTime,
        finishedAt: baseTime,
        failure: {
          kind: 'INSTALL_FAILED',
          message: 'wrong stage',
          retryable: false,
        },
        stepResults: [
          valid,
          {
            ...valid,
            stage: 'INSTALL',
            status: 'FAILED',
            failure: {
              kind: 'INSTALL_FAILED',
              message: 'wrong stage',
              retryable: false,
            },
          },
        ],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      assertCiExecutionState('QUEUED', 'QUEUED', {
        status: 'NOT_STARTED',
        attemptNumber: 1,
        fence: 0,
        stepResults: [],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      assertCiExecutionState('RUNNING', 'BUILD', {
        status: 'PASSED',
        attemptNumber: 1,
        fence: 1,
        attemptId,
        startedAt: baseTime,
        finishedAt: baseTime,
        stepResults: CI_STAGES.map((stage) => ({ ...valid, stage })),
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      assertCiExecutionState('RUNNING', 'BUILD', {
        status: 'PASSED',
        attemptNumber: 1,
        fence: 1,
        attemptId,
        startedAt: baseTime,
        finishedAt: new Date(baseTime.valueOf() + 10),
        cleanup: { status: 'CLEANED', completedAt: baseTime },
        stepResults: CI_STAGES.map((stage) => ({ ...valid, stage })),
      }),
    ValidationError,
  );
});

test('CI claim, fencing, and successful contiguous execution are CAS guarded', async () => {
  const { repositories: repos } = repositories();
  const deployment = await repos.deployments.createQueued({
    projectId,
    commitSha: sha,
  });
  const claim = await repos.deployments.claimCiExecution(deployment.id, {
    now: baseTime,
    leaseMs: 10_000,
  });
  assert.ok(claim);
  assert.equal(claim.deployment.stage, 'CHECKOUT');
  assert.equal(
    (await repos.deployments.claimCiExecution(deployment.id, { now: baseTime }))
      ?.attemptId,
    undefined,
  );
  let current = claim.deployment;
  for (const stageName of CI_STAGES) {
    current = await repos.deployments.recordCiStepOutcome(
      deployment.id,
      {
        expectedVersion: current.version,
        attemptId: claim.attemptId,
        fence: claim.fence,
        ...step(
          stageName,
          'PASSED',
          undefined,
          stageName === 'BUILD' ? cleaned : undefined,
        ),
      },
      new Date(baseTime.valueOf() + 20),
    );
  }
  assert.equal(current.status, 'RUNNING');
  assert.equal(current.stage, 'BUILD');
  assert.equal(current.ci?.status, 'PASSED');
  assert.deepEqual(current.ci?.cleanup, cleaned);
  assert.equal(current.ci?.stepResults.length, 4);
  const duplicate = await repos.deployments.recordCiStepOutcome(
    deployment.id,
    {
      expectedVersion: 1,
      attemptId: claim.attemptId,
      fence: claim.fence,
      ...step('CHECKOUT'),
    },
    baseTime,
  );
  assert.equal(duplicate.version, current.version);
  await assert.rejects(
    repos.deployments.recordCiStepOutcome(deployment.id, {
      expectedVersion: current.version,
      attemptId,
      fence: 99,
      ...step('BUILD'),
    }),
    ConcurrencyError,
  );
});

test('CI renewal rechecks lease expiry in the atomic update filter', async () => {
  const { repositories: repos, collections } = repositories();
  const deployment = await repos.deployments.createQueued({
    projectId,
    commitSha: sha,
  });
  const claim = await repos.deployments.claimCiExecution(deployment.id, {
    now: baseTime,
    leaseMs: 10_000,
  });
  assert.ok(claim);
  const collection = collections.get('deployments')!;
  const stored = collection.documents.find((item) => item._id === deployment.id)!;
  let updateCalls = 0;
  collection.beforeUpdate = () => {
    updateCalls += 1;
    if (updateCalls === 1) {
      const ci = stored.ci as Record<string, unknown>;
      ci.leaseExpiresAt = new Date(baseTime.valueOf() - 1);
    }
  };
  await assert.rejects(
    repos.deployments.renewCiExecution(
      deployment.id,
      {
        expectedVersion: claim.deployment.version,
        attemptId: claim.attemptId,
        fence: claim.fence,
        leaseMs: 10_000,
      },
      new Date(baseTime.valueOf() + 1),
    ),
    ConcurrencyError,
  );
  assert.equal(updateCalls, 1);
  assert.equal(stored.version, claim.deployment.version);
});

test('CI repository operations map driver failures to PersistenceError', async () => {
  const { repositories: repos, collections } = repositories();
  const deployment = await repos.deployments.createQueued({
    projectId,
    commitSha: sha,
  });
  const claim = await repos.deployments.claimCiExecution(deployment.id, {
    now: baseTime,
  });
  assert.ok(claim);
  const collection = collections.get('deployments')!;
  collection.findFailure = new Error('driver details must not escape');
  await assert.rejects(
    repos.deployments.renewCiExecution(deployment.id, {
      expectedVersion: claim.deployment.version,
      attemptId: claim.attemptId,
      fence: claim.fence,
    }),
    PersistenceError,
  );
  await assert.rejects(
    repos.deployments.recordCiStepOutcome(deployment.id, {
      expectedVersion: claim.deployment.version,
      attemptId: claim.attemptId,
      fence: claim.fence,
      ...step('CHECKOUT'),
    }),
    PersistenceError,
  );
  collection.findFailure = undefined;
  collection.updateFailure = new Error('update driver details must not escape');
  const second = await repos.deployments.createQueued({ projectId, commitSha: sha });
  await assert.rejects(
    repos.deployments.claimCiExecution(second.id, { now: baseTime }),
    PersistenceError,
  );
});

test('concurrent fresh claims have one winner at the repository boundary', async () => {
  const { repositories: repos } = repositories();
  const deployment = await repos.deployments.createQueued({
    projectId,
    commitSha: sha,
  });
  const claims = await Promise.all([
    repos.deployments.claimCiExecution(deployment.id, {
      now: baseTime,
      leaseMs: 10_000,
    }),
    repos.deployments.claimCiExecution(deployment.id, {
      now: baseTime,
      leaseMs: 10_000,
    }),
  ]);
  assert.equal(claims.filter((claim) => claim !== null).length, 1);
});

test('retry and expired reclaim reset to checkout and reject stale fences', async () => {
  const { repositories: repos } = repositories();
  const deployment = await repos.deployments.createQueued({
    projectId,
    commitSha: sha,
  });
  const first = await repos.deployments.claimCiExecution(deployment.id, {
    now: baseTime,
    leaseMs: 10_000,
  });
  assert.ok(first);
  const pending = await repos.deployments.recordCiStepOutcome(
    deployment.id,
    {
      expectedVersion: first.deployment.version,
      attemptId: first.attemptId,
      fence: first.fence,
      ...step(
        'CHECKOUT',
        'FAILED',
        {
          kind: 'CHECKOUT_FAILED',
          message: 'retry',
          retryable: true,
        },
        cleaned,
      ),
    },
    baseTime,
  );
  assert.equal(pending.ci?.status, 'RETRY_PENDING');
  assert.deepEqual(pending.ci?.cleanup, cleaned);
  const retry = await repos.deployments.claimCiExecution(deployment.id, {
    now: new Date(20_000),
    leaseMs: 10_000,
  });
  assert.ok(retry);
  assert.equal(retry.fence, first.fence + 1);
  assert.equal(retry.deployment.stage, 'CHECKOUT');
  assert.equal(retry.deployment.ci?.stepResults.length, 0);
  await assert.rejects(
    repos.deployments.recordCiStepOutcome(deployment.id, {
      expectedVersion: pending.version,
      attemptId: first.attemptId,
      fence: first.fence,
      ...step('CHECKOUT'),
    }),
    ConcurrencyError,
  );
  const progressed = await repos.deployments.recordCiStepOutcome(
    deployment.id,
    {
      expectedVersion: retry.deployment.version,
      attemptId: retry.attemptId,
      fence: retry.fence,
      ...step('CHECKOUT'),
    },
    new Date(20_010),
  );
  const expired = await repos.deployments.reclaimExpiredCiExecution(deployment.id, {
    now: new Date(31_000),
    leaseMs: 10_000,
  });
  assert.ok(expired);
  assert.equal(expired.fence, retry.fence + 1);
  assert.equal(expired.deployment.stage, 'CHECKOUT');
  assert.equal(expired.deployment.ci?.stepResults.length, 0);
  await repos.deployments.renewCiExecution(
    expired.deployment.id,
    {
      expectedVersion: expired.deployment.version,
      attemptId: expired.attemptId,
      fence: expired.fence,
      leaseMs: 10_000,
    },
    new Date(31_050),
  );
  await assert.rejects(
    repos.deployments.renewCiExecution(
      retry.deployment.id,
      {
        expectedVersion: expired.deployment.version,
        attemptId: first.attemptId,
        fence: first.fence,
        leaseMs: 10_000,
      },
      new Date(31_060),
    ),
    ConcurrencyError,
  );
  assert.equal(progressed.stage, 'INSTALL');
});

test('non-retryable CI failure preserves the exact failing stage', async () => {
  const { repositories: repos } = repositories();
  const deployment = await repos.deployments.createQueued({
    projectId,
    commitSha: sha,
  });
  const claim = await repos.deployments.claimCiExecution(deployment.id, {
    now: baseTime,
  });
  assert.ok(claim);
  const checkout = await repos.deployments.recordCiStepOutcome(
    deployment.id,
    {
      expectedVersion: claim.deployment.version,
      attemptId: claim.attemptId,
      fence: claim.fence,
      ...step('CHECKOUT'),
    },
    baseTime,
  );
  const install = await repos.deployments.recordCiStepOutcome(
    deployment.id,
    {
      expectedVersion: checkout.version,
      attemptId: claim.attemptId,
      fence: claim.fence,
      ...step('INSTALL'),
    },
    baseTime,
  );
  const failed = await repos.deployments.recordCiStepOutcome(
    deployment.id,
    {
      expectedVersion: install.version,
      attemptId: claim.attemptId,
      fence: claim.fence,
      ...step(
        'TEST',
        'FAILED',
        {
          kind: 'TEST_FAILED',
          message: 'tests failed',
          retryable: false,
        },
        cleaned,
      ),
    },
    new Date(baseTime.valueOf() + 20),
  );
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.stage, 'TEST');
  assert.equal(failed.ci?.status, 'FAILED');
  assert.deepEqual(failed.ci?.cleanup, cleaned);
});

test('CI lease index is declared and malformed embedded state is rejected', async () => {
  assert.equal(
    DOMAIN_INDEXES.deployments.some(
      (index) => index.name === 'deployments_ci_lease_expiry',
    ),
    true,
  );
  const { repositories: repos, collections } = repositories();
  const deployment = await repos.deployments.createQueued({
    projectId,
    commitSha: sha,
  });
  const collection = collections.get('deployments')!;
  const stored = collection.documents.find((item) => item._id === deployment.id)!;
  stored.ci = {
    status: 'RUNNING',
    attemptNumber: 1,
    fence: 1,
    attemptId,
    stepResults: [],
  };
  await assert.rejects(repos.deployments.findById(deployment.id), PersistenceError);
});
