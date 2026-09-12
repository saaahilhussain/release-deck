import { Worker, type Job, type Processor, type WorkerOptions } from 'bullmq';

import {
  DEPLOYMENT_QUEUE_NAME,
  parseDeploymentJobData,
  type DeploymentJobData,
  type QueueConnection,
} from './deployment-queue.js';

export interface WorkerLike {
  waitUntilReady(): Promise<unknown>;
  cancelAllJobs(reason?: string): void;
  close(): Promise<void>;
}

export interface DeploymentJobContext {
  readonly signal?: AbortSignal;
  readonly attemptsMade: number;
  readonly maxAttempts: number;
}

export type DeploymentJobProcessor = (
  job: DeploymentJobData,
  context: DeploymentJobContext,
) => Promise<void>;

export interface DeploymentWorkerDependencies {
  createWorker?: (
    name: string,
    processor: Processor<DeploymentJobData, void>,
    options: WorkerOptions,
  ) => WorkerLike;
}

function defaultWorker(
  name: string,
  processor: Processor<DeploymentJobData, void>,
  options: WorkerOptions,
): WorkerLike {
  return new Worker<DeploymentJobData, void>(name, processor, options);
}

export interface DeploymentWorker {
  waitUntilReady(): Promise<void>;
  close(): Promise<void>;
}

export function createDeploymentWorker(
  connection: QueueConnection,
  processor: DeploymentJobProcessor,
  options: Pick<WorkerOptions, 'concurrency' | 'prefix'> = {},
  dependencies: DeploymentWorkerDependencies = {},
): DeploymentWorker {
  const worker = (dependencies.createWorker ?? defaultWorker)(
    DEPLOYMENT_QUEUE_NAME,
    async (job: Job<DeploymentJobData>, _token?: string, signal?: AbortSignal) => {
      await processor(parseDeploymentJobData(job.data), {
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
        ...(signal === undefined ? {} : { signal }),
      });
    },
    {
      connection,
      concurrency: options.concurrency ?? 1,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    },
  );
  let closing: Promise<void> | undefined;
  return {
    async waitUntilReady() {
      await worker.waitUntilReady();
    },
    close() {
      if (!closing) {
        worker.cancelAllJobs('ReleaseDeck worker is shutting down');
        closing = worker.close();
      }
      return closing;
    },
  };
}
