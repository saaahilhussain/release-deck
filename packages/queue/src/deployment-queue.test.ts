import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEPLOYMENT_JOB_NAME,
  DEPLOYMENT_QUEUE_NAME,
  createDeploymentQueue,
  deploymentJobId,
  parseDeploymentJobData,
} from './deployment-queue.js';

test('deployment job IDs are deterministic normalized UUIDs', () => {
  const id = '550E8400-E29B-41D4-A716-446655440000';
  assert.equal(deploymentJobId(id), id.toLowerCase());
  assert.throws(() => deploymentJobId('not-an-id'), TypeError);
});

test('deployment job data accepts only deploymentId', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  assert.deepEqual(parseDeploymentJobData({ deploymentId: id }), {
    deploymentId: id,
  });
  assert.throws(
    () => parseDeploymentJobData({ deploymentId: id, extra: true }),
    TypeError,
  );
  assert.throws(() => parseDeploymentJobData({ deploymentId: 'invalid' }), TypeError);
});

test('queue wrapper enqueues with fixed name, deterministic ID, and retained jobs', async () => {
  const added: Array<{ name: string; data: unknown; options: unknown }> = [];
  let configuredOptions: unknown;
  let closeCalls = 0;
  const queue = createDeploymentQueue({} as never, {
    prefix: 'verification-prefix',
    createQueue: (_name, options) => {
      configuredOptions = options;
      return {
        add: async (jobName, data, jobOptions) => {
          added.push({ name: jobName, data, options: jobOptions });
        },
        waitUntilReady: async () => undefined,
        close: async () => {
          closeCalls += 1;
        },
      };
    },
  });
  await queue.waitUntilReady();
  await queue.enqueueDeployment('550E8400-E29B-41D4-A716-446655440000');
  assert.equal(queue.name, DEPLOYMENT_QUEUE_NAME);
  assert.equal(
    (configuredOptions as { prefix?: unknown }).prefix,
    'verification-prefix',
  );
  assert.deepEqual(
    (configuredOptions as { defaultJobOptions?: unknown }).defaultJobOptions,
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  );
  assert.deepEqual(added, [
    {
      name: DEPLOYMENT_JOB_NAME,
      data: { deploymentId: '550e8400-e29b-41d4-a716-446655440000' },
      options: { jobId: '550e8400-e29b-41d4-a716-446655440000' },
    },
  ]);
  await Promise.all([queue.close(), queue.close()]);
  assert.equal(closeCalls, 1);
});
