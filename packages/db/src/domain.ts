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
  readonly sourceWebhookEventId?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DeploymentCreateInput {
  readonly projectId: string;
  readonly commitSha: string;
  readonly provider?: Provider;
  readonly sourceWebhookEventId?: string;
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
  /** SHA-256 of the exact verified raw request body; legacy records may omit it. */
  readonly payloadSha256?: string;
  readonly processingStatus: WebhookProcessingStatus;
  readonly version: number;
  readonly updatedAt: Date;
  readonly projectId?: string;
  readonly commitSha?: string;
  readonly deploymentId?: string;
  readonly ignoredReason?: WebhookIgnoredReason;
  readonly createdAt: Date;
}

export interface WebhookEventCreateInput {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly action?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly provider?: Provider;
  readonly payloadSha256?: string;
  readonly processingStatus?: WebhookProcessingStatus;
  readonly version?: number;
  readonly projectId?: string;
  readonly commitSha?: string;
  readonly deploymentId?: string;
  readonly ignoredReason?: WebhookIgnoredReason;
}

export const WEBHOOK_PROCESSING_STATUSES = [
  'RECEIVED',
  'IGNORED',
  'QUEUE_PENDING',
  'QUEUED',
] as const;
export type WebhookProcessingStatus = (typeof WEBHOOK_PROCESSING_STATUSES)[number];

export const WEBHOOK_IGNORED_REASONS = [
  'unsupported_event',
  'unknown_project',
  'non_default_branch',
  'deleted_ref',
  'invalid_payload',
] as const;
export type WebhookIgnoredReason = (typeof WEBHOOK_IGNORED_REASONS)[number];

export interface WebhookEventTransition {
  readonly expectedVersion: number;
  readonly processingStatus: WebhookProcessingStatus;
  readonly projectId?: string;
  readonly commitSha?: string;
  readonly deploymentId?: string;
  readonly ignoredReason?: WebhookIgnoredReason;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

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
  const { owner, repository } = normalizeProjectCoordinates(input);
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

export function normalizeProjectCoordinates(input: {
  readonly owner: string;
  readonly repository: string;
}): { owner: string; repository: string } {
  const owner = input.owner.trim().toLowerCase();
  const repository = input.repository.trim().toLowerCase();
  if (
    owner.length > 39 ||
    !GITHUB_OWNER_PATTERN.test(owner) ||
    repository.length > 100 ||
    !GITHUB_REPOSITORY_PATTERN.test(repository)
  ) {
    throw new ValidationError('project coordinates are invalid');
  }
  return { owner, repository };
}

export function normalizeSha(input: DeploymentCreateInput): string {
  return normalizeCommitSha(input.commitSha);
}

function normalizeCommitSha(value: string): string {
  const sha = value.trim().toLowerCase();
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
  const sourceWebhookEventId = input.sourceWebhookEventId?.trim().toLowerCase();
  if (sourceWebhookEventId !== undefined && !UUID_PATTERN.test(sourceWebhookEventId)) {
    throw new ValidationError('source webhook event ID is invalid');
  }
  return {
    id: randomUUID(),
    projectId,
    provider: PROVIDER,
    commitSha: normalizeSha(input),
    status: 'QUEUED',
    stage: 'QUEUED',
    version: 1,
    ...(sourceWebhookEventId === undefined ? {} : { sourceWebhookEventId }),
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
  const payloadSha256 = input.payloadSha256?.trim().toLowerCase();
  if (payloadSha256 !== undefined && !SHA256_PATTERN.test(payloadSha256)) {
    throw new ValidationError('webhook payload digest is invalid');
  }
  const processingStatus = input.processingStatus ?? 'RECEIVED';
  if (!WEBHOOK_PROCESSING_STATUSES.includes(processingStatus)) {
    throw new ValidationError('webhook processing status is invalid');
  }
  const version = input.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError('webhook event version is invalid');
  }
  const projectId = normalizeOptionalUuid(input.projectId, 'project ID');
  const deploymentId = normalizeOptionalUuid(input.deploymentId, 'deployment ID');
  const commitSha =
    input.commitSha === undefined ? undefined : normalizeCommitSha(input.commitSha);
  const ignoredReason = input.ignoredReason;
  if (ignoredReason !== undefined && !WEBHOOK_IGNORED_REASONS.includes(ignoredReason)) {
    throw new ValidationError('webhook ignored reason is invalid');
  }
  const eventNow = new Date(nowValue(now));
  const record: WebhookEvent = {
    id: randomUUID(),
    provider: PROVIDER,
    deliveryId,
    eventName,
    ...(action === undefined ? {} : { action }),
    metadata,
    ...(payloadSha256 === undefined ? {} : { payloadSha256 }),
    processingStatus,
    version,
    updatedAt: eventNow,
    ...(projectId === undefined ? {} : { projectId }),
    ...(commitSha === undefined ? {} : { commitSha }),
    ...(deploymentId === undefined ? {} : { deploymentId }),
    ...(ignoredReason === undefined ? {} : { ignoredReason }),
    createdAt: eventNow,
  };
  assertWebhookEventState(record);
  return record;
}

function nowValue(value: Date): number {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new ValidationError('webhook event timestamp is invalid');
  }
  return value.valueOf();
}

function normalizeOptionalUuid(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new ValidationError(`${label} is invalid`);
  return normalized;
}

function normalizeWebhookStateFields(input: {
  projectId?: string;
  commitSha?: string;
  deploymentId?: string;
  ignoredReason?: WebhookIgnoredReason;
}): {
  projectId?: string;
  commitSha?: string;
  deploymentId?: string;
  ignoredReason?: WebhookIgnoredReason;
} {
  const projectId = normalizeOptionalUuid(input.projectId, 'project ID');
  const deploymentId = normalizeOptionalUuid(input.deploymentId, 'deployment ID');
  const commitSha =
    input.commitSha === undefined ? undefined : normalizeCommitSha(input.commitSha);
  if (
    input.ignoredReason !== undefined &&
    !WEBHOOK_IGNORED_REASONS.includes(input.ignoredReason)
  ) {
    throw new ValidationError('webhook ignored reason is invalid');
  }
  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(commitSha === undefined ? {} : { commitSha }),
    ...(deploymentId === undefined ? {} : { deploymentId }),
    ...(input.ignoredReason === undefined
      ? {}
      : { ignoredReason: input.ignoredReason }),
  };
}

export function assertWebhookEventState(
  event: Pick<
    WebhookEvent,
    | 'processingStatus'
    | 'payloadSha256'
    | 'projectId'
    | 'commitSha'
    | 'deploymentId'
    | 'ignoredReason'
  >,
): void {
  if (!WEBHOOK_PROCESSING_STATUSES.includes(event.processingStatus)) {
    throw new ValidationError('webhook processing status is invalid');
  }
  if (
    event.ignoredReason !== undefined &&
    !WEBHOOK_IGNORED_REASONS.includes(event.ignoredReason)
  ) {
    throw new ValidationError('webhook ignored reason is invalid');
  }
  const hasQueueFields =
    event.projectId !== undefined &&
    event.commitSha !== undefined &&
    event.deploymentId !== undefined;
  if (event.processingStatus === 'RECEIVED') {
    const hasProject = event.projectId !== undefined;
    const hasCommit = event.commitSha !== undefined;
    const legacyRecord = event.payloadSha256 === undefined && !hasProject && !hasCommit;
    if (
      event.deploymentId !== undefined ||
      event.ignoredReason !== undefined ||
      hasProject !== hasCommit ||
      (!legacyRecord && !hasProject)
    ) {
      throw new ValidationError('received webhook event has outcome fields');
    }
    return;
  }
  if (event.processingStatus === 'IGNORED') {
    if (
      event.payloadSha256 === undefined ||
      event.ignoredReason === undefined ||
      event.commitSha !== undefined ||
      event.deploymentId !== undefined
    ) {
      throw new ValidationError('ignored webhook event state is invalid');
    }
    return;
  }
  if (
    (event.processingStatus === 'QUEUE_PENDING' ||
      event.processingStatus === 'QUEUED') &&
    (event.payloadSha256 === undefined ||
      !hasQueueFields ||
      event.ignoredReason !== undefined)
  ) {
    throw new ValidationError('queued webhook event state is invalid');
  }
}

export function transitionWebhookEvent(
  current: WebhookEvent,
  transition: WebhookEventTransition,
  now = new Date(),
): WebhookEvent {
  if (
    !Number.isSafeInteger(transition.expectedVersion) ||
    transition.expectedVersion !== current.version
  ) {
    throw new InvalidTransitionError('webhook event version is stale');
  }
  if (current.processingStatus === transition.processingStatus) {
    throw new InvalidTransitionError('webhook event transition is a no-op');
  }
  const allowed: Record<WebhookProcessingStatus, readonly WebhookProcessingStatus[]> = {
    RECEIVED: ['IGNORED', 'QUEUE_PENDING'],
    IGNORED: [],
    QUEUE_PENDING: ['QUEUED'],
    QUEUED: [],
  };
  if (!allowed[current.processingStatus].includes(transition.processingStatus)) {
    throw new InvalidTransitionError('webhook event transition is not allowed');
  }
  const fields = normalizeWebhookStateFields(transition);
  const next: WebhookEvent = {
    ...current,
    processingStatus: transition.processingStatus,
    version: current.version + 1,
    updatedAt: now,
    ...(fields.projectId === undefined ? {} : { projectId: fields.projectId }),
    ...(fields.commitSha === undefined ? {} : { commitSha: fields.commitSha }),
    ...(fields.deploymentId === undefined ? {} : { deploymentId: fields.deploymentId }),
    ...(fields.ignoredReason === undefined
      ? {}
      : { ignoredReason: fields.ignoredReason }),
  };
  if (transition.processingStatus === 'IGNORED') {
    delete (next as { projectId?: string }).projectId;
    delete (next as { commitSha?: string }).commitSha;
    delete (next as { deploymentId?: string }).deploymentId;
  } else if (transition.processingStatus === 'QUEUE_PENDING') {
    delete (next as { ignoredReason?: WebhookIgnoredReason }).ignoredReason;
  }
  assertWebhookEventState(next);
  return next;
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

export function assertDeploymentState(
  status: DeploymentStatus,
  stage: DeploymentStage,
): void {
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
