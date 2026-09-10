import { randomUUID } from 'node:crypto';

import { InvalidTransitionError, ValidationError } from './errors.js';

export const PROVIDER = 'github' as const;
export type Provider = typeof PROVIDER;

export interface Project {
  readonly id: string;
  readonly provider: Provider;
  readonly owner: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProjectCreateInput {
  readonly owner: string;
  readonly repository: string;
  readonly defaultBranch?: string;
  readonly provider?: Provider;
}

export interface Deployment {
  readonly id: string;
  readonly projectId: string;
  readonly provider: Provider;
  readonly commitSha: string;
  readonly status: DeploymentStatus;
  readonly stage: DeploymentStage;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DeploymentCreateInput {
  readonly projectId: string;
  readonly commitSha: string;
  readonly provider?: Provider;
}

export const DEPLOYMENT_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCESS',
  'FAILED',
  'ROLLED_BACK',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const DEPLOYMENT_STAGES = [
  'QUEUED',
  'CHECKOUT',
  'INSTALL',
  'TEST',
  'BUILD',
  'DEPLOY',
  'HEALTH_CHECK',
  'PROMOTE',
  'COMPLETE',
  'ROLLBACK',
] as const;
export type DeploymentStage = (typeof DEPLOYMENT_STAGES)[number];

export interface DeploymentTransition {
  readonly expectedVersion: number;
  readonly status?: DeploymentStatus;
  readonly stage?: DeploymentStage;
}

export interface WebhookEvent {
  readonly id: string;
  readonly provider: Provider;
  readonly deliveryId: string;
  readonly eventName: string;
  readonly action?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: Date;
}

export interface WebhookEventCreateInput {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly action?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly provider?: Provider;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export function normalizeProjectInput(input: ProjectCreateInput): {
  owner: string;
  repository: string;
  defaultBranch: string;
} {
  const owner = input.owner.trim().toLowerCase();
  const repository = input.repository.trim().toLowerCase();
  const defaultBranch = (input.defaultBranch ?? 'main').trim();
  if (
    owner.length > 39 ||
    !GITHUB_OWNER_PATTERN.test(owner) ||
    repository.length > 100 ||
    !GITHUB_REPOSITORY_PATTERN.test(repository)
  ) {
    throw new ValidationError('project coordinates are invalid');
  }
  if (
    !defaultBranch ||
    defaultBranch.length > 255 ||
    containsControlCharacter(defaultBranch)
  ) {
    throw new ValidationError('default branch is invalid');
  }
  return { owner, repository, defaultBranch };
}

export function normalizeSha(input: DeploymentCreateInput): string {
  const sha = input.commitSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new ValidationError('commit SHA is invalid');
  return sha;
}

function requireGithub(provider: Provider | undefined): void {
  if (provider !== undefined && provider !== PROVIDER) {
    throw new ValidationError('provider is invalid');
  }
}

export function createProject(input: ProjectCreateInput, now = new Date()): Project {
  requireGithub(input.provider);
  const coordinates = normalizeProjectInput(input);
  return {
    id: randomUUID(),
    provider: PROVIDER,
    ...coordinates,
    createdAt: now,
    updatedAt: now,
  };
}

export function createQueuedDeployment(
  input: DeploymentCreateInput,
  now = new Date(),
): Deployment {
  requireGithub(input.provider);
  const projectId = input.projectId.trim().toLowerCase();
  if (!UUID_PATTERN.test(projectId)) {
    throw new ValidationError('project ID is invalid');
  }
  return {
    id: randomUUID(),
    projectId,
    provider: PROVIDER,
    commitSha: normalizeSha(input),
    status: 'QUEUED',
    stage: 'QUEUED',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function createWebhookEvent(
  input: WebhookEventCreateInput,
  now = new Date(),
): WebhookEvent {
  requireGithub(input.provider);
  const deliveryId = input.deliveryId.trim();
  const eventName = input.eventName.trim();
  if (
    !deliveryId ||
    deliveryId.length > 255 ||
    containsControlCharacter(deliveryId) ||
    !eventName ||
    eventName.length > 100 ||
    containsControlCharacter(eventName)
  ) {
    throw new ValidationError('webhook event metadata is invalid');
  }
  const action = input.action?.trim();
  if (
    action !== undefined &&
    (action.length === 0 || action.length > 100 || containsControlCharacter(action))
  )
    throw new ValidationError('webhook action is invalid');
  const entries = Object.entries(input.metadata ?? {});
  if (
    entries.length > 20 ||
    entries.some(
      ([key, value]) =>
        key.length === 0 ||
        key.length > 100 ||
        containsControlCharacter(key) ||
        typeof value !== 'string' ||
        value.length > 500 ||
        containsControlCharacter(value),
    )
  ) {
    throw new ValidationError('webhook metadata is invalid');
  }
  const metadata = Object.fromEntries(entries);
  return {
    id: randomUUID(),
    provider: PROVIDER,
    deliveryId,
    eventName,
    ...(action === undefined ? {} : { action }),
    metadata,
    createdAt: now,
  };
}

const stageOrder = new Map<DeploymentStage, number>(
  DEPLOYMENT_STAGES.map((stage, index) => [stage, index]),
);
const runningStages = new Set<DeploymentStage>([
  'CHECKOUT',
  'INSTALL',
  'TEST',
  'BUILD',
  'DEPLOY',
  'HEALTH_CHECK',
  'PROMOTE',
]);

function assertDeploymentState(status: DeploymentStatus, stage: DeploymentStage): void {
  const valid =
    (status === 'QUEUED' && stage === 'QUEUED') ||
    (status === 'RUNNING' && runningStages.has(stage)) ||
    (status === 'SUCCESS' && stage === 'COMPLETE') ||
    (status === 'FAILED' && runningStages.has(stage)) ||
    (status === 'ROLLED_BACK' && stage === 'ROLLBACK');
  if (!valid) {
    throw new InvalidTransitionError('deployment status and stage are inconsistent');
  }
}

/** Pure state machine used by the repository's compare-and-swap update. */
export function transitionDeployment(
  current: Deployment,
  transition: DeploymentTransition,
  now = new Date(),
): Deployment {
  if (transition.expectedVersion !== current.version) {
    throw new InvalidTransitionError('deployment version is stale');
  }
  const status = transition.status ?? current.status;
  const stage = transition.stage ?? current.stage;
  if (status === current.status && stage === current.stage) {
    throw new InvalidTransitionError('deployment transition is a no-op');
  }

  if (status !== current.status) {
    const allowed: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
      QUEUED: ['RUNNING'],
      RUNNING: ['SUCCESS', 'FAILED'],
      SUCCESS: ['ROLLED_BACK'],
      FAILED: [],
      ROLLED_BACK: [],
    };
    if (!allowed[current.status].includes(status)) throw new InvalidTransitionError();
  }
  assertDeploymentState(status, stage);
  if (stage !== current.stage) {
    const previousOrder = stageOrder.get(current.stage);
    const nextOrder = stageOrder.get(stage);
    if (nextOrder === undefined) {
      throw new InvalidTransitionError('deployment stage is invalid');
    }
    if (previousOrder !== undefined && nextOrder < previousOrder) {
      throw new InvalidTransitionError('deployment stage cannot move backwards');
    }
    if (
      current.status === 'FAILED' ||
      current.status === 'ROLLED_BACK' ||
      (current.status === 'SUCCESS' && status === 'SUCCESS')
    ) {
      throw new InvalidTransitionError('terminal deployment stage cannot change');
    }
  }
  return { ...current, status, stage, version: current.version + 1, updatedAt: now };
}

export const guardedDeploymentTransition = transitionDeployment;
