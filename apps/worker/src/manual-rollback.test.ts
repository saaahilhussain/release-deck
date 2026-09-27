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

function harness(
  outcome: Awaited<ReturnType<ManualRollbackOperations['rollbackRelease']>>,
) {
  const active = deployment(activeId, 'b'.repeat(40));
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
  let final = active;
  const repositories: ManualRollbackRepositories = {
    deployments: {
      claimManualRollback: async () => claim,
      reclaimExpiredManualRollback: async () => null,
      renewManualRollback: async () => active,
      recordManualRollbackOutcome: async (_id, input) => {
        calls.push('persist-restored');
        assert.equal(input.target.deploymentId, targetId);
        assert.equal(input.target.commitSha, previous.commitSha);
        assert.equal(input.health.statusCode, 200);
        final = {
          ...active,
          status: 'ROLLED_BACK',
          stage: 'ROLLBACK',
          release: {
            ...active.release!,
            status: 'ROLLED_BACK',
            manualRollback: {
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
        return final;
      },
      recordManualRollbackFailure: async (_id, input) => {
        calls.push('persist-failed');
        assert.equal(input.target.deploymentId, targetId);
        final = {
          ...active,
          status: input.activeHealth ? 'SUCCESS' : 'FAILED',
          stage: input.activeHealth ? 'COMPLETE' : 'ROLLBACK',
        };
        return final;
      },
      recordManualRollbackRejected: async (_id, input) => {
        calls.push('persist-rejected');
        assert.equal(input.target.deploymentId, targetId);
        final = {
          ...active,
          release: {
            ...active.release!,
            manualRollback: {
              ...claim.deployment.release!.manualRollback!,
              status: 'REJECTED',
              failure: input.failure,
              finishedAt: new Date(),
            },
          },
        };
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
      return outcome;
    },
  };
  return { repositories, operations, calls, final: () => final };
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
