import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentWorker } from './deployment-worker.js';

test('worker validates job data before invoking the processor', async () => {
  let received: unknown;
  let receivedSignal: AbortSignal | undefined;
  let closeCalls = 0;
  let configuredPrefix: unknown;
  let capturedProcessor:
    | ((
        job: { data: unknown },
        token?: string,
        signal?: AbortSignal,
      ) => Promise<void>)
    | undefined;
  const controller = new AbortController();
  const worker = createDeploymentWorker(
    {} as never,
    async (job, context) => {
      received = job;
      receivedSignal = context.signal;
    },
    { prefix: 'verification-prefix' },
    {
      createWorker: (_name, processor, options) => {
        configuredPrefix = options.prefix;
        // Capture the adapter callback so this test does not require Redis.
        capturedProcessor = processor as typeof capturedProcessor;
        return {
          waitUntilReady: async () => undefined,
          close: async () => {
            closeCalls += 1;
          },
        };
      },
    },
  );
  await worker.waitUntilReady();
  await capturedProcessor!(
    {
      data: { deploymentId: '550E8400-E29B-41D4-A716-446655440000' },
    },
    'token',
    controller.signal,
  );
  assert.deepEqual(received, {
    deploymentId: '550e8400-e29b-41d4-a716-446655440000',
  });
  assert.equal(receivedSignal, controller.signal);
  assert.equal(configuredPrefix, 'verification-prefix');
  await Promise.all([worker.close(), worker.close()]);
  assert.equal(closeCalls, 1);
});
