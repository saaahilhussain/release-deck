import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQueuedDeployment,
  type Deployment,
  type ReleaseFailureInput,
  type ReleaseSuccessInput,
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

function harness(activationError?: unknown, successError?: unknown) {
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
      recordReleaseSuccess: async (_id, input: ReleaseSuccessInput) => {
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
            finishedAt: new Date(),
          },
        };
        return current;
      },
      recordReleaseFailure: async (_id, input: ReleaseFailureInput) => {
        current = {
          ...current,
          status: input.failure.retryable ? 'RUNNING' : 'FAILED',
          stage: 'DEPLOY',
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
    async activateRelease() {
      calls.push('activate');
      if (activationError) throw activationError;
      const releasePath = `/srv/apps/${projectId}/releases/${deploymentId}`;
      return {
        projectId,
        deploymentId,
        commitSha,
        remoteReleasePath: releasePath,
        activeTarget: releasePath,
        pm2ProcessName: `releasedeck-${projectId}`,
        pm2Pid: 123,
        nginx: { validated: true, reloaded: true },
        completedAt: new Date(),
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
