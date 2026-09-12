import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentWorker } from './deployment-worker.js';

test('worker validates job data before invoking the processor', async () => {
  let received: unknown;
  let receivedSignal: AbortSignal | undefined;
  let receivedAttempts: readonly number[] | undefined;
  let closeCalls = 0;
  let cancelCalls = 0;
  let configuredPrefix: unknown;
  let capturedProcessor:
    | ((
        job: { data: unknown; attemptsMade: number; opts: { attempts?: number } },
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
      receivedAttempts = [context.attemptsMade, context.maxAttempts];
    },
    { prefix: 'verification-prefix' },
    {
      createWorker: (_name, processor, options) => {
        configuredPrefix = options.prefix;
        // Capture the adapter callback so this test does not require Redis.
        capturedProcessor = processor as typeof capturedProcessor;
        return {
          waitUntilReady: async () => undefined,
          cancelAllJobs: () => {
            cancelCalls += 1;
          },
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
      attemptsMade: 1,
      opts: { attempts: 3 },
    },
    'token',
    controller.signal,
  );
  assert.deepEqual(received, {
    deploymentId: '550e8400-e29b-41d4-a716-446655440000',
  });
  assert.equal(receivedSignal, controller.signal);
  assert.deepEqual(receivedAttempts, [1, 3]);
  assert.equal(configuredPrefix, 'verification-prefix');
  await Promise.all([worker.close(), worker.close()]);
  assert.equal(cancelCalls, 1);
  assert.equal(closeCalls, 1);
});

test('closing cancels an active processor before waiting for it to drain', async () => {
  const controller = new AbortController();
  const events: string[] = [];
  let capturedProcessor:
    | ((
        job: { data: unknown; attemptsMade: number; opts: { attempts?: number } },
        token?: string,
        signal?: AbortSignal,
      ) => Promise<void>)
    | undefined;
  let processorStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    processorStarted = resolve;
  });
  const worker = createDeploymentWorker(
    {} as never,
    async (_job, context) => {
      events.push('processor-started');
      processorStarted?.();
      await new Promise<void>((resolve) => {
        if (context.signal?.aborted) {
          resolve();
          return;
        }
        context.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      events.push('processor-stopped');
    },
    {},
    {
      createWorker: (_name, processor) => {
        capturedProcessor = processor as typeof capturedProcessor;
        return {
          waitUntilReady: async () => undefined,
          cancelAllJobs: () => {
            events.push('cancel');
            controller.abort();
          },
          close: async () => {
            events.push('close-started');
            await activeProcessor;
            events.push('close-finished');
          },
        };
      },
    },
  );

  const activeProcessor = capturedProcessor!(
    {
      data: { deploymentId: '550e8400-e29b-41d4-a716-446655440000' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    },
    'token',
    controller.signal,
  );
  await started;
  await worker.close();

  assert.deepEqual(events, [
    'processor-started',
    'cancel',
    'close-started',
    'processor-stopped',
    'close-finished',
  ]);
});
