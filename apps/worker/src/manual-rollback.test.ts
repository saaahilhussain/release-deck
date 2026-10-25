import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQueuedDeployment,
  type Deployment,
  type ManualRollbackClaim,
} from '@releasedeck/db';
import { ReleaseDeployerError } from '@releasedeck/release-deployer';

import {
  processManualRollback,
  type ManualRollbackOperations,
  type ManualRollbackRepositories,
} from './manual-rollback.js';

const projectId = '550e8400-e29b-41d4-a716-446655440001';
const activeId = '550e8400-e29b-41d4-a716-446655440002';
const targetId = '550e8400-e29b-41d4-a716-446655440003';
const requestId = '550e8400-e29b-41d4-a716-446655440004';
const attemptId = '550e8400-e29b-41d4-a716-446655440005';
const healthUrl = 'http://127.0.0.1:3000/health';
const target = {
  host: 'target.example.com',
  port: 22,
  user: 'deployer',
  privateKeyPath: 'D:\\keys\\release',
  knownHostsPath: 'D:\\keys\\known_hosts',
  remoteRoot: '/srv/apps',
  timeoutMs: 60_000,
  outputLimitBytes: 65_536,
  healthUrl,
  healthAttempts: 5,
  healthIntervalMs: 1_000,
  healthRequestTimeoutMs: 2_000,
};
const options = { leaseMs: 60_000, retention: 5, target };
type RollbackOutcome = Awaited<ReturnType<ManualRollbackOperations['rollbackRelease']>>;

interface HarnessControls {
  readonly renew?: (current: Deployment) => Promise<Deployment>;
  readonly run?: (outcome: RollbackOutcome) => Promise<RollbackOutcome>;
}

function deployment(id: string, commitSha: string): Deployment {
  const current = createQueuedDeployment({ projectId, commitSha });
  const releasePath = `/srv/apps/${projectId}/releases/${id}`;
  return {
    ...current,
    id,
    status: 'SUCCESS',
    stage: 'COMPLETE',
    version: 3,
    release: {
      status: 'DEPLOYED',
      releaseId: id,
      attemptNumber: 1,
      attemptId,
      fence: 1,
      success: {
        releaseId: id,
        commitSha,
        remoteReleasePath: releasePath,
        activeTarget: releasePath,
        pm2ProcessName: `releasedeck-${projectId}`,
        pm2Pid: 123,
        nginx: { validated: true, reloaded: true },
        completedAt: new Date(),
      },
      health: { url: healthUrl, statusCode: 200, attempts: 1, completedAt: new Date() },
    },
  };
}

function remoteProof(id: string, commitSha: string) {
  return {
    ...deployment(id, commitSha).release!.success!,
    projectId,
    deploymentId: id,
    nginx: { validated: true as const, reloaded: true as const },
  };
}

function harness(outcome: RollbackOutcome, controls: HarnessControls = {}) {
  const claimedAt = new Date();
  const activeBase = deployment(activeId, 'b'.repeat(40));
  const active: Deployment = {
    ...activeBase,
    version: activeBase.version + 1,
    updatedAt: claimedAt,
    release: {
      ...activeBase.release!,
      manualRollback: {
        requestId,
        targetDeploymentId: targetId,
        status: 'RUNNING',
        attemptId,
        attemptNumber: 1,
        fence: 2,
        leaseExpiresAt: new Date(claimedAt.valueOf() + 60_000),
        heartbeatAt: claimedAt,
        startedAt: claimedAt,
      },
    },
  };
  const previous = deployment(targetId, 'a'.repeat(40));
  const claim: ManualRollbackClaim = {
    requestId,
    attemptId,
    fence: 2,
    attemptNumber: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    deployment: active,
    targetDeployment: previous,
  };
  const calls: string[] = [];
  const renewalVersions: number[] = [];
  const outcomeVersions: number[] = [];
  let current = active;
  let final = active;
  const repositories: ManualRollbackRepositories = {
    deployments: {
      claimManualRollback: async () => claim,
      reclaimExpiredManualRollback: async () => null,
      renewManualRollback: async (_id, input) => {
        renewalVersions.push(input.expectedVersion);
        assert.equal(input.expectedVersion, current.version);
        current = controls.renew
          ? await controls.renew(current)
          : { ...current, version: current.version + 1 };
        return current;
      },
      recordManualRollbackOutcome: async (_id, input) => {
        calls.push('persist-restored');
        outcomeVersions.push(input.expectedVersion);
        assert.equal(input.expectedVersion, current.version);
        assert.equal(input.target.deploymentId, targetId);
        assert.equal(input.target.commitSha, previous.commitSha);
        assert.equal(input.health.statusCode, 200);
        final = {
          ...current,
          status: 'ROLLED_BACK',
          stage: 'ROLLBACK',
          version: current.version + 1,
          release: {
            ...current.release!,
            status: 'ROLLED_BACK',
            manualRollback: {
              ...current.release!.manualRollback!,
              requestId,
              targetDeploymentId: targetId,
              status: 'RESTORED',
              attemptId,
              attemptNumber: 1,
              fence: 2,
              startedAt: new Date(),
            },
          },
        };
        current = final;
        return final;
      },
      recordManualRollbackFailure: async (_id, input) => {
        calls.push('persist-failed');
        outcomeVersions.push(input.expectedVersion);
        assert.equal(input.expectedVersion, current.version);
        assert.equal(input.target.deploymentId, targetId);
        final = {
          ...current,
          status: input.activeHealth ? 'SUCCESS' : 'FAILED',
          stage: input.activeHealth ? 'COMPLETE' : 'ROLLBACK',
          version: current.version + 1,
        };
        current = final;
        return final;
      },
      recordManualRollbackRejected: async (_id, input) => {
        calls.push('persist-rejected');
        outcomeVersions.push(input.expectedVersion);
        assert.equal(input.expectedVersion, current.version);
        assert.equal(input.target.deploymentId, targetId);
        final = {
          ...current,
          version: current.version + 1,
          release: {
            ...current.release!,
            manualRollback: {
              ...current.release!.manualRollback!,
              status: 'REJECTED',
              failure: input.failure,
              finishedAt: new Date(),
            },
          },
        };
        current = final;
        return final;
      },
    },
  };
  const operations: ManualRollbackOperations = {
    async rollbackRelease(input) {
      calls.push('remote-rollback');
      assert.equal(input.requestId, requestId);
      assert.equal(input.deploymentId, activeId);
      assert.equal(input.targetDeploymentId, targetId);
      assert.equal(input.targetCommitSha, previous.commitSha);
      return controls.run ? controls.run(outcome) : outcome;
    },
  };
  return {
    repositories,
    operations,
    calls,
    renewalVersions,
    outcomeVersions,
    final: () => final,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('manual rollback uses the built predecessor and persists restored health', async () => {
  const state = harness({
    status: 'RESTORED',
    proof: remoteProof(targetId, 'a'.repeat(40)),
    healthProof: {
      url: healthUrl,
      statusCode: 200,
      attempts: 2,
      completedAt: new Date(),
    },
  });
  const result = await processManualRollback(
    activeId,
    targetId,
    state.repositories,
    state.operations,
    options,
  );
  assert.equal(result.status, 'ROLLED_BACK');
  assert.deepEqual(state.calls, ['remote-rollback', 'persist-restored']);
});

test('manual rollback finalization drains its heartbeat and uses the latest version', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const operationStarted = deferred();
  const finishOperation = deferred();
  const heartbeatStarted = deferred();
  const finishHeartbeat = deferred();
  const outcome: RollbackOutcome = {
    status: 'RESTORED',
    proof: remoteProof(targetId, 'a'.repeat(40)),
    healthProof: {
      url: healthUrl,
      statusCode: 200,
      attempts: 2,
      completedAt: new Date(),
    },
  };
  const state = harness(outcome, {
    async run(result) {
      operationStarted.resolve();
      await finishOperation.promise;
      return result;
    },
    async renew(current) {
      heartbeatStarted.resolve();
      await finishHeartbeat.promise;
      const heartbeatAt = new Date();
      return {
        ...current,
        version: current.version + 1,
        release: {
          ...current.release!,
          manualRollback: {
            ...current.release!.manualRollback!,
            heartbeatAt,
            leaseExpiresAt: new Date(heartbeatAt.valueOf() + 60_000),
          },
        },
      };
    },
  });

  const processing = processManualRollback(
    activeId,
    targetId,
    state.repositories,
    state.operations,
    options,
  );
  await operationStarted.promise;
  t.mock.timers.tick(20_000);
  await heartbeatStarted.promise;
  finishOperation.resolve();
  await Promise.resolve();
  assert.deepEqual(state.outcomeVersions, []);
  finishHeartbeat.resolve();
  const result = await processing;

  assert.deepEqual(state.renewalVersions, [4]);
  assert.deepEqual(state.outcomeVersions, [5]);
  assert.equal(result.status, 'ROLLED_BACK');
  t.mock.timers.tick(100_000);
  assert.deepEqual(state.renewalVersions, [4]);
});

test('manual rollback heartbeat failure prevents a stale final outcome', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const operationStarted = deferred();
  const finishOperation = deferred();
  const heartbeatStarted = deferred();
  const failHeartbeat = deferred();
  const persistenceError = new Error('MongoDB unavailable');
  const state = harness(
    {
      status: 'RESTORED',
      proof: remoteProof(targetId, 'a'.repeat(40)),
      healthProof: {
        url: healthUrl,
        statusCode: 200,
        attempts: 1,
        completedAt: new Date(),
      },
    },
    {
      async run(result) {
        operationStarted.resolve();
        await finishOperation.promise;
        return result;
      },
      async renew() {
        heartbeatStarted.resolve();
        await failHeartbeat.promise;
        throw persistenceError;
      },
    },
  );

  const processing = processManualRollback(
    activeId,
    targetId,
    state.repositories,
    state.operations,
    options,
  );
  await operationStarted.promise;
  t.mock.timers.tick(20_000);
  await heartbeatStarted.promise;
  finishOperation.resolve();
  await Promise.resolve();
  failHeartbeat.resolve();
  await assert.rejects(processing, persistenceError);

  assert.deepEqual(state.renewalVersions, [4]);
  assert.deepEqual(state.outcomeVersions, []);
  assert.deepEqual(state.calls, ['remote-rollback']);
});

test('failed target health with active recovery keeps the active release successful', async () => {
  const state = harness({
    status: 'FAILED_ACTIVE_RESTORED',
    active: { projectId, deploymentId: activeId, commitSha: 'b'.repeat(40) },
    attemptedRestore: { projectId, deploymentId: targetId, commitSha: 'a'.repeat(40) },
    proof: remoteProof(activeId, 'b'.repeat(40)),
    healthProof: {
      url: healthUrl,
      statusCode: 200,
      attempts: 1,
      completedAt: new Date(),
    },
  });
  const result = await processManualRollback(
    activeId,
    targetId,
    state.repositories,
    state.operations,
    options,
  );
  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(state.calls, ['remote-rollback', 'persist-failed']);
});

test('reclaim never executes an older request for a different target', async () => {
  const state = harness({
    status: 'RESTORED',
    proof: remoteProof(targetId, 'a'.repeat(40)),
    healthProof: {
      url: healthUrl,
      statusCode: 200,
      attempts: 1,
      completedAt: new Date(),
    },
  });
  let requestedTarget: string | undefined;
  const repositories: ManualRollbackRepositories = {
    deployments: {
      ...state.repositories.deployments,
      claimManualRollback: async () => null,
      reclaimExpiredManualRollback: async (_activeId, targetDeploymentId) => {
        requestedTarget = targetDeploymentId;
        return {
          requestId,
          attemptId,
          fence: 2,
          attemptNumber: 2,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          deployment: deployment(activeId, 'b'.repeat(40)),
          targetDeployment: deployment(
            '550e8400-e29b-41d4-a716-446655440006',
            'c'.repeat(40),
          ),
        };
      },
    },
  };
  await assert.rejects(
    processManualRollback(activeId, targetId, repositories, state.operations, options),
    /manual rollback target changed/,
  );
  assert.equal(requestedTarget, targetId);
  assert.deepEqual(state.calls, []);
});

test('remote transport uncertainty is recorded as a failed manual rollback', async () => {
  const state = harness({
    status: 'RESTORED',
    proof: remoteProof(targetId, 'a'.repeat(40)),
    healthProof: {
      url: healthUrl,
      statusCode: 200,
      attempts: 1,
      completedAt: new Date(),
    },
  });
  const result = await processManualRollback(
    activeId,
    targetId,
    state.repositories,
    {
      rollbackRelease: async () => {
        throw new Error('SSH disconnected');
      },
    },
    options,
  );
  assert.equal(result.status, 'FAILED');
  assert.deepEqual(state.calls, ['persist-failed']);
});

test('stale target precondition rejection leaves historical release successful', async () => {
  const state = harness({
    status: 'RESTORED',
    proof: remoteProof(targetId, 'a'.repeat(40)),
    healthProof: {
      url: healthUrl,
      statusCode: 200,
      attempts: 1,
      completedAt: new Date(),
    },
  });
  const result = await processManualRollback(
    activeId,
    targetId,
    state.repositories,
    {
      rollbackRelease: async () => {
        throw new ReleaseDeployerError('remote', 'remote precondition failed', {
          exitCode: 66,
        });
      },
    },
    options,
  );
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.release?.manualRollback?.status, 'REJECTED');
  assert.deepEqual(state.calls, ['persist-rejected']);
});
