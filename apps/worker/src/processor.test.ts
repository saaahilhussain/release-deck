import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConcurrencyError,
  createQueuedDeployment,
  type Deployment,
} from '@releasedeck/db';

import { processDeploymentJob } from './processor.js';

const job = { deploymentId: '550e8400-e29b-41d4-a716-446655440000' };

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    ...createQueuedDeployment({
      projectId: '550e8400-e29b-41d4-a716-446655440001',
      commitSha: 'a'.repeat(40),
    }),
    id: job.deploymentId,
    ...overrides,
  };
}

test('worker atomically begins a queued deployment at checkout', async () => {
  const current = deployment();
  let transitionInput: unknown;
  await processDeploymentJob(job, {
    findById: async () => current,
    transition: async (_id, input) => {
      transitionInput = input;
      return deployment({ status: 'RUNNING', stage: 'CHECKOUT', version: 2 });
    },
  });
  assert.deepEqual(transitionInput, {
    expectedVersion: 1,
    status: 'RUNNING',
    stage: 'CHECKOUT',
  });
});

test('duplicate jobs are no-ops after the deployment has started', async () => {
  let transitions = 0;
  await processDeploymentJob(job, {
    findById: async () =>
      deployment({ status: 'RUNNING', stage: 'CHECKOUT', version: 2 }),
    transition: async () => {
      transitions += 1;
      return deployment();
    },
  });
  assert.equal(transitions, 0);
});

test('a CAS loser refetches and accepts a concurrent winner', async () => {
  let reads = 0;
  await processDeploymentJob(job, {
    findById: async () => {
      reads += 1;
      return reads === 1
        ? deployment()
        : deployment({ status: 'RUNNING', stage: 'CHECKOUT', version: 2 });
    },
    transition: async () => {
      throw new ConcurrencyError();
    },
  });
  assert.equal(reads, 2);
});

test('missing deployments reject for BullMQ retry', async () => {
  await assert.rejects(
    processDeploymentJob(job, {
      findById: async () => null,
      transition: async () => deployment(),
    }),
    /deployment was not found/,
  );
});

test('persistence failures reject for BullMQ retry', async () => {
  await assert.rejects(
    processDeploymentJob(job, {
      findById: async () => deployment(),
      transition: async () => {
        throw new Error('database unavailable');
      },
    }),
    /database unavailable/,
  );
});
