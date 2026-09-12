import { Queue } from 'bullmq';
import type { JobsOptions, QueueOptions } from 'bullmq';
import type { Redis } from 'ioredis';

export const DEPLOYMENT_QUEUE_NAME = 'releasedeck-deployments' as const;
export const DEPLOYMENT_JOB_NAME = 'deployment' as const;

export interface DeploymentJobData {
  readonly deploymentId: string;
}

export type QueueConnection = Redis | QueueOptions['connection'];

export interface QueueLike {
  add(name: string, data: DeploymentJobData, options: JobsOptions): Promise<unknown>;
  waitUntilReady(): Promise<unknown>;
  close(): Promise<void>;
}

export interface DeploymentQueueDependencies {
  prefix?: string;
  createQueue?: (name: string, options: QueueOptions) => QueueLike;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isDeploymentId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function deploymentJobId(deploymentId: string): string {
  if (typeof deploymentId !== 'string' || !isDeploymentId(deploymentId)) {
    throw new TypeError('deployment ID is invalid');
  }
  return deploymentId.toLowerCase();
}

export function parseDeploymentJobData(value: unknown): DeploymentJobData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('deployment job data is invalid');
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'deploymentId') {
    throw new TypeError('deployment job data is invalid');
  }
  const deploymentId = (value as { deploymentId?: unknown }).deploymentId;
  if (typeof deploymentId !== 'string') {
    throw new TypeError('deployment job data is invalid');
  }
  return { deploymentId: deploymentJobId(deploymentId) };
}

function defaultQueue(name: string, options: QueueOptions): QueueLike {
  return new Queue<DeploymentJobData>(name, options);
}

export interface DeploymentQueue {
  readonly name: typeof DEPLOYMENT_QUEUE_NAME;
  waitUntilReady(): Promise<void>;
  enqueueDeployment(deploymentId: string): Promise<void>;
  close(): Promise<void>;
}

export function createDeploymentQueue(
  connection: QueueConnection,
  dependencies: DeploymentQueueDependencies = {},
): DeploymentQueue {
  const queue = (dependencies.createQueue ?? defaultQueue)(DEPLOYMENT_QUEUE_NAME, {
    connection,
    ...(dependencies.prefix === undefined ? {} : { prefix: dependencies.prefix }),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
  let closing: Promise<void> | undefined;
  return {
    name: DEPLOYMENT_QUEUE_NAME,
    async waitUntilReady() {
      await queue.waitUntilReady();
    },
    async enqueueDeployment(deploymentId) {
      const jobId = deploymentJobId(deploymentId);
      await queue.add(DEPLOYMENT_JOB_NAME, { deploymentId: jobId }, { jobId });
    },
    close() {
      closing ??= queue.close();
      return closing;
    },
  };
}
