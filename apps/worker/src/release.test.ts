import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQueuedDeployment,
  type Deployment,
  type ReleaseFailureInput,
  type ReleasePromotionInput,
} from '@releasedeck/db';
import { ReleaseDeployerError } from '@releasedeck/release-deployer';

import {
  processReleaseDeployment,
  type ReleaseOperations,
  type ReleaseProcessorRepositories,
} from './release.js';

const deploymentId = '550e8400-e29b-41d4-a716-446655440000';
const projectId = '550e8400-e29b-41d4-a716-446655440001';
const attemptId = '550e8400-e29b-41d4-a716-446655440002';
const commitSha = 'a'.repeat(40);
const target = {
  host: 'target.example.com',
  port: 22,
  user: 'deployer',
  privateKeyPath: 'D:\\keys\\release',
  knownHostsPath: 'D:\\keys\\known_hosts',
  remoteRoot: '/srv/apps',
  timeoutMs: 60_000,
  outputLimitBytes: 65_536,
  healthUrl: 'http://127.0.0.1:3000/health',
  healthAttempts: 5,
  healthIntervalMs: 1000,
  healthRequestTimeoutMs: 2000,
};
const options = {
  artifactRoot: 'D:\\artifacts',
  leaseMs: 60_000,
  retention: 5,
  target,
  activeLeasePollMs: 1,
};

function ciPassed(): Deployment {
  const now = new Date();
  return {
    ...createQueuedDeployment({ projectId, commitSha }),
    id: deploymentId,
    status: 'RUNNING',
    stage: 'BUILD',
    ci: {
      status: 'PASSED',
      attemptNumber: 1,
      attemptId,
      fence: 1,
      startedAt: now,
      finishedAt: now,
      cleanup: { status: 'CLEANED', completedAt: now },
      stepResults: [],
    },
  };
}

function harness(
  activationError?: unknown,
  successError?: unknown,
  promotionOutcome?: Awaited<ReturnType<ReleaseOperations['promoteRelease']>>,
) {
  let current = ciPassed();
  const calls: string[] = [];
  const repositories: ReleaseProcessorRepositories = {
    deployments: {
      findById: async () => current,
      claimReleaseExecution: async () => {
        const now = new Date();
        current = {
          ...current,
          stage: 'DEPLOY',
          version: current.version + 1,
          release: {
            status: 'RUNNING',
            releaseId: deploymentId,
            attemptNumber: 1,
            attemptId,
            fence: 1,
            leaseExpiresAt: new Date(now.valueOf() + 60_000),
            heartbeatAt: now,
            startedAt: now,
          },
        };
        return {
          attemptId,
          fence: 1,
          attemptNumber: 1,
          leaseExpiresAt: current.release!.leaseExpiresAt!,
          deployment: current,
        };
      },
      reclaimExpiredReleaseExecution: async () => null,
      renewReleaseExecution: async () => current,
      advanceReleaseStage: async (_id, input) => {
        current = { ...current, stage: input.stage, version: current.version + 1 };
        return current;
      },
      recordReleasePromotion: async (_id, input: ReleasePromotionInput) => {
        if (successError) throw successError;
        current = {
          ...current,
          status: 'SUCCESS',
          stage: 'COMPLETE',
          version: current.version + 1,
          release: {
            ...current.release!,
            status: 'DEPLOYED',
            success: input.proof,
            health: input.health,
            finishedAt: new Date(),
          },
        };
        return current;
      },
      recordReleaseRollback: async (_id, input) => {
        current = {
          ...current,
          status: 'ROLLED_BACK',
          stage: 'ROLLBACK',
          version: current.version + 1,
          release: {
            ...current.release!,
            status: 'ROLLED_BACK',
            rollback: {
              mode: 'AUTOMATIC',
              outcome: 'RESTORED',
              target: input.target,
              health: input.health,
              completedAt: new Date(),
            },
          },
        };
        return current;
      },
      recordReleaseRollbackFailure: async (_id, input) => {
        current = {
          ...current,
          status: 'FAILED',
          stage: 'ROLLBACK',
          version: current.version + 1,
          release: {
            ...current.release!,
            status: 'ROLLBACK_FAILED',
            rollback: {
              mode: 'AUTOMATIC',
              outcome: 'FAILED',
              target: input.attemptedTarget,
              failure: input.failure,
              completedAt: new Date(),
            },
          },
        };
        return current;
      },
      recordReleaseFailure: async (_id, input: ReleaseFailureInput) => {
        current = {
          ...current,
          status: input.failure.retryable ? 'RUNNING' : 'FAILED',
          stage: input.failure.kind === 'NO_KNOWN_GOOD' ? 'HEALTH_CHECK' : 'DEPLOY',
          version: current.version + 1,
          release: {
            ...current.release!,
            status: input.failure.retryable ? 'RETRY_PENDING' : 'FAILED',
            failure: input.failure,
            ...(input.failure.retryable ? {} : { finishedAt: new Date() }),
          },
        };
        return current;
      },
    },
  };
  const operations: ReleaseOperations = {
    async openPreparedRelease() {
      calls.push('open');
      return {
        projectId,
        deploymentId,
        commitSha,
        archivePath: 'D:\\artifacts\\release.tar.gz',
        metadataPath: 'D:\\artifacts\\metadata.json',
        archiveSha256: 'b'.repeat(64),
      };
    },
    async stageRelease() {
      calls.push('stage');
    },
    async promoteRelease() {
      calls.push('activate');
      if (activationError) throw activationError;
      if (promotionOutcome) return promotionOutcome;
      const releasePath = `/srv/apps/${projectId}/releases/${deploymentId}`;
      return {
        status: 'PROMOTED',
        proof: {
          projectId,
          deploymentId,
          commitSha,
          remoteReleasePath: releasePath,
          activeTarget: releasePath,
          pm2ProcessName: `releasedeck-${projectId}`,
          pm2Pid: 123,
          nginx: { validated: true, reloaded: true },
          completedAt: new Date(),
        },
        healthProof: {
          url: target.healthUrl,
          statusCode: 200,
          attempts: 1,
          completedAt: new Date(),
        },
      };
    },
    async cleanupPreparedRelease() {
      calls.push('cleanup');
    },
  };
  return { repositories, operations, calls, current: () => current };
}

test('a fenced release attempt stages, activates, cleans, and records proof', async () => {
  const state = harness();
  await processReleaseDeployment(
    deploymentId,
    { attemptsMade: 0, maxAttempts: 3 },
    state.repositories,
    state.operations,
    options,
  );
  assert.deepEqual(state.calls, ['open', 'stage', 'activate', 'cleanup']);
  assert.equal(state.current().status, 'SUCCESS');
  assert.equal(state.current().stage, 'COMPLETE');
  assert.equal(state.current().release?.success?.releaseId, deploymentId);
});

test('a retryable transport failure is persisted and rethrown for BullMQ', async () => {
  const error = new ReleaseDeployerError('transport', 'upload failed');
  const state = harness(error);
  await assert.rejects(
    processReleaseDeployment(
      deploymentId,
      { attemptsMade: 0, maxAttempts: 3 },
      state.repositories,
      state.operations,
      options,
    ),
    error,
  );
  assert.equal(state.current().release?.status, 'RETRY_PENDING');
  assert.equal(state.current().release?.failure?.kind, 'TRANSPORT_FAILED');
  assert.deepEqual(state.calls, ['open', 'stage', 'activate']);
});

test('an exhausted remote failure ends at FAILED/DEPLOY', async () => {
  const state = harness(new ReleaseDeployerError('remote', 'reload failed'));
  await processReleaseDeployment(
    deploymentId,
    { attemptsMade: 2, maxAttempts: 3 },
    state.repositories,
    state.operations,
    options,
  );
  assert.equal(state.current().status, 'FAILED');
  assert.equal(state.current().stage, 'DEPLOY');
  assert.equal(state.current().release?.failure?.kind, 'REMOTE_FAILED');
  assert.deepEqual(state.calls, ['open', 'stage', 'activate', 'cleanup']);
});

test('a failed authoritative success write preserves the prepared artifact', async () => {
  const persistenceError = new Error('MongoDB unavailable');
  const state = harness(undefined, persistenceError);
  await assert.rejects(
    processReleaseDeployment(
      deploymentId,
      { attemptsMade: 0, maxAttempts: 3 },
      state.repositories,
      state.operations,
      options,
    ),
    persistenceError,
  );
  assert.deepEqual(state.calls, ['open', 'stage', 'activate']);
  assert.equal(state.current().release?.status, 'RUNNING');
});

test('a nonterminal deployment without a release claim preserves its artifact', async () => {
  const current = {
    ...ciPassed(),
    ci: { ...ciPassed().ci!, status: 'RUNNING' as const },
  };
  const calls: string[] = [];
  const state = harness();
  await processReleaseDeployment(
    deploymentId,
    { attemptsMade: 0, maxAttempts: 3 },
    {
      deployments: {
        ...state.repositories.deployments,
        findById: async () => current,
      },
    },
    {
      ...state.operations,
      cleanupPreparedRelease: async () => {
        calls.push('cleanup');
      },
    },
    options,
  );
  assert.deepEqual(calls, []);
});

test('an unhealthy candidate records the restored predecessor without success', async () => {
  const predecessorId = '550e8400-e29b-41d4-a716-446655440003';
  const releasePath = `/srv/apps/${projectId}/releases/${predecessorId}`;
  const state = harness(undefined, undefined, {
    status: 'ROLLED_BACK',
    candidate: { projectId, deploymentId, commitSha },
    restored: {
      projectId,
      deploymentId: predecessorId,
      releaseId: predecessorId,
      commitSha: 'b'.repeat(40),
      remoteReleasePath: releasePath,
      activeTarget: releasePath,
    },
    healthProof: {
      url: target.healthUrl,
      statusCode: 200,
      attempts: 2,
      completedAt: new Date(),
    },
  });
  await processReleaseDeployment(
    deploymentId,
    { attemptsMade: 0, maxAttempts: 3 },
    state.repositories,
    state.operations,
    options,
  );
  assert.equal(state.current().status, 'ROLLED_BACK');
  assert.equal(state.current().stage, 'ROLLBACK');
  assert.equal(state.current().release?.rollback?.target.deploymentId, predecessorId);
  assert.equal(state.current().release?.success, undefined);
  assert.deepEqual(state.calls, ['open', 'stage', 'activate', 'cleanup']);
});

test('failed restoration records rollback failure without claiming a healthy target', async () => {
  const predecessorId = '550e8400-e29b-41d4-a716-446655440003';
  const state = harness(undefined, undefined, {
    status: 'ROLLBACK_FAILED',
    candidate: { projectId, deploymentId, commitSha },
    attemptedRestore: {
      projectId,
      deploymentId: predecessorId,
      commitSha: 'b'.repeat(40),
    },
    failureCode: 'restore_unhealthy',
  });
  await processReleaseDeployment(
    deploymentId,
    { attemptsMade: 0, maxAttempts: 3 },
    state.repositories,
    state.operations,
    options,
  );
  assert.equal(state.current().status, 'FAILED');
  assert.equal(state.current().stage, 'ROLLBACK');
  assert.equal(state.current().release?.status, 'ROLLBACK_FAILED');
  assert.equal(state.current().release?.rollback?.health, undefined);
});

test('an unhealthy first release records no known-good predecessor', async () => {
  const state = harness(undefined, undefined, {
    status: 'NO_KNOWN_GOOD',
    candidate: { projectId, deploymentId, commitSha },
    failureCode: 'no_known_good',
  });
  await processReleaseDeployment(
    deploymentId,
    { attemptsMade: 0, maxAttempts: 3 },
    state.repositories,
    state.operations,
    options,
  );
  assert.equal(state.current().status, 'FAILED');
  assert.equal(state.current().stage, 'HEALTH_CHECK');
  assert.equal(state.current().release?.failure?.kind, 'NO_KNOWN_GOOD');
});
