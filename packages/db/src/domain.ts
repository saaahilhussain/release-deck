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
  readonly ci?: DeploymentCiExecution;
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

export const CI_EXECUTION_STATUSES = [
  'NOT_STARTED',
  'RUNNING',
  'RETRY_PENDING',
  'PASSED',
  'FAILED',
  'TIMED_OUT',
] as const;
export type CiExecutionStatus = (typeof CI_EXECUTION_STATUSES)[number];

export const CI_STAGES = ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD'] as const;
export type CiStage = (typeof CI_STAGES)[number];

export const CI_STEP_STATUSES = ['PASSED', 'FAILED', 'TIMED_OUT'] as const;
export type CiStepStatus = (typeof CI_STEP_STATUSES)[number];

export const CI_FAILURE_KINDS = [
  'CHECKOUT_FAILED',
  'INSTALL_FAILED',
  'TEST_FAILED',
  'BUILD_FAILED',
  'COMMAND_TIMEOUT',
  'SPAWN_FAILED',
  'WORKSPACE_FAILED',
  'LEASE_LOST',
  'CANCELLED',
] as const;
export type CiFailureKind = (typeof CI_FAILURE_KINDS)[number];

export const MAX_CI_STEP_RESULTS = 4;
export const MAX_CI_OUTPUT_BYTES = 1_048_576;
export const MAX_CI_MESSAGE_BYTES = 2_000;
// Keep persistence bounds aligned with the runtime's configured CI lease range.
export const DEFAULT_CI_LEASE_MS = 60_000;
export const MIN_CI_LEASE_MS = 10_000;
export const MAX_CI_LEASE_MS = 300_000;

export interface CiFailure {
  readonly kind: CiFailureKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly exitCode?: number;
  readonly signal?: string;
}

export const CI_CLEANUP_STATUSES = ['CLEANED', 'FAILED'] as const;
export type CiCleanupStatus = (typeof CI_CLEANUP_STATUSES)[number];

export interface CiCleanupEvidence {
  readonly status: CiCleanupStatus;
  readonly completedAt: Date;
}

export interface CiStepResult {
  readonly stage: CiStage;
  readonly status: CiStepStatus;
  readonly attemptId: string;
  readonly fence: number;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly failure?: CiFailure;
}

export interface CiStepResultInput {
  readonly stage: CiStage;
  readonly status: CiStepStatus;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
  readonly failure?: CiFailure;
}

export interface DeploymentCiExecution {
  readonly status: CiExecutionStatus;
  readonly attemptNumber: number;
  /** Fencing value; it increases every time an attempt is claimed/reclaimed. */
  readonly fence: number;
  /** The most recently claimed attempt; required once CI has started. */
  readonly attemptId?: string;
  readonly leaseExpiresAt?: Date;
  readonly heartbeatAt?: Date;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  readonly failure?: CiFailure;
  /** Set when the attempt's disposable workspace cleanup has completed. */
  readonly cleanup?: CiCleanupEvidence;
  readonly stepResults: readonly CiStepResult[];
}

export interface CiExecutionClaim {
  readonly attemptId: string;
  readonly fence: number;
  readonly attemptNumber: number;
  readonly leaseExpiresAt: Date;
  readonly deployment: Deployment;
}

export interface CiExecutionLeaseInput {
  readonly expectedVersion: number;
  readonly attemptId: string;
  readonly fence: number;
  readonly leaseMs?: number;
}

export interface CiStepOutcomeInput extends CiStepResultInput {
  readonly expectedVersion: number;
  readonly attemptId: string;
  readonly fence: number;
  /** Required for terminal outcomes and the final BUILD outcome. */
  readonly cleanup?: CiCleanupEvidence;
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

function isDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.valueOf());
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertCiFailure(failure: CiFailure | undefined): void {
  if (failure === undefined) return;
  if (
    typeof failure !== 'object' ||
    failure === null ||
    !CI_FAILURE_KINDS.includes(failure.kind) ||
    typeof failure.message !== 'string'
  ) {
    throw new ValidationError('CI failure is invalid');
  }
  if (!failure.message.trim() || byteLength(failure.message) > MAX_CI_MESSAGE_BYTES) {
    throw new ValidationError('CI failure message is invalid');
  }
  if (typeof failure.retryable !== 'boolean') {
    throw new ValidationError('CI failure retryability is invalid');
  }
  if (
    failure.exitCode !== undefined &&
    (!Number.isSafeInteger(failure.exitCode) ||
      failure.exitCode < 0 ||
      failure.exitCode > 255)
  ) {
    throw new ValidationError('CI failure exit code is invalid');
  }
  if (
    failure.signal !== undefined &&
    (typeof failure.signal !== 'string' || !/^[A-Z0-9_]{1,32}$/.test(failure.signal))
  ) {
    throw new ValidationError('CI failure signal is invalid');
  }
}

function failureMatchesStage(
  stage: CiStage,
  status: CiStepStatus,
  failure: CiFailure,
): boolean {
  if (status === 'TIMED_OUT') return failure.kind === 'COMMAND_TIMEOUT';
  if (
    failure.kind === 'SPAWN_FAILED' ||
    failure.kind === 'WORKSPACE_FAILED' ||
    failure.kind === 'LEASE_LOST' ||
    failure.kind === 'CANCELLED'
  ) {
    return true;
  }
  return failure.kind === `${stage}_FAILED`;
}

function sameFailure(
  left: CiFailure | undefined,
  right: CiFailure | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertCiCleanupEvidence(cleanup: CiCleanupEvidence | undefined): void {
  if (cleanup === undefined) return;
  if (
    typeof cleanup !== 'object' ||
    cleanup === null ||
    !CI_CLEANUP_STATUSES.includes(cleanup.status) ||
    !isDate(cleanup.completedAt)
  ) {
    throw new ValidationError('CI cleanup evidence is invalid');
  }
}

export function assertCiOutcomeCleanup(
  stage: CiStage,
  status: CiStepStatus,
  cleanup: CiCleanupEvidence | undefined,
): void {
  assertCiCleanupEvidence(cleanup);
  const requiresCleanup = status !== 'PASSED' || stage === 'BUILD';
  if (requiresCleanup && cleanup === undefined) {
    throw new ValidationError('terminal CI outcome requires cleanup evidence');
  }
  if (!requiresCleanup && cleanup !== undefined) {
    throw new ValidationError(
      'intermediate CI outcome cannot include cleanup evidence',
    );
  }
}

function assertCiStepResult(result: CiStepResult): void {
  if (
    typeof result !== 'object' ||
    result === null ||
    !CI_STAGES.includes(result.stage) ||
    !CI_STEP_STATUSES.includes(result.status) ||
    !UUID_PATTERN.test(result.attemptId) ||
    !Number.isSafeInteger(result.fence) ||
    result.fence < 1 ||
    !isDate(result.startedAt) ||
    !isDate(result.finishedAt) ||
    result.finishedAt.valueOf() < result.startedAt.valueOf() ||
    !Number.isSafeInteger(result.durationMs) ||
    result.durationMs < 0 ||
    result.durationMs > 86_400_000 ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    byteLength(result.stdout) > MAX_CI_OUTPUT_BYTES ||
    byteLength(result.stderr) > MAX_CI_OUTPUT_BYTES ||
    typeof result.stdoutTruncated !== 'boolean' ||
    typeof result.stderrTruncated !== 'boolean'
  ) {
    throw new ValidationError('CI step result is invalid');
  }
  if (result.status === 'PASSED' && result.failure !== undefined) {
    throw new ValidationError('passed CI step cannot have a failure');
  }
  if (result.status !== 'PASSED' && result.failure === undefined) {
    throw new ValidationError('failed CI step requires a failure');
  }
  assertCiFailure(result.failure);
  if (
    result.failure !== undefined &&
    !failureMatchesStage(result.stage, result.status, result.failure)
  ) {
    throw new ValidationError('CI failure does not match its stage or status');
  }
}

/** Validate and normalize one bounded CI result before persistence. */
export function createCiStepResult(
  attemptId: string,
  fence: number,
  input: CiStepResultInput,
): CiStepResult {
  const normalizedAttemptId = attemptId.trim().toLowerCase();
  if (
    !UUID_PATTERN.test(normalizedAttemptId) ||
    !Number.isSafeInteger(fence) ||
    fence < 1
  ) {
    throw new ValidationError('CI fencing token is invalid');
  }
  if (
    typeof input !== 'object' ||
    input === null ||
    !isDate(input.startedAt) ||
    !isDate(input.finishedAt)
  ) {
    throw new ValidationError('CI step timestamps are invalid');
  }
  if (
    (input.stdout !== undefined && typeof input.stdout !== 'string') ||
    (input.stderr !== undefined && typeof input.stderr !== 'string') ||
    (input.stdoutTruncated !== undefined &&
      typeof input.stdoutTruncated !== 'boolean') ||
    (input.stderrTruncated !== undefined && typeof input.stderrTruncated !== 'boolean')
  ) {
    throw new ValidationError('CI step output is invalid');
  }
  const result: CiStepResult = {
    stage: input.stage,
    status: input.status,
    attemptId: normalizedAttemptId,
    fence,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
    stdoutTruncated: input.stdoutTruncated ?? false,
    stderrTruncated: input.stderrTruncated ?? false,
    ...(input.failure === undefined ? {} : { failure: input.failure }),
  };
  assertCiStepResult(result);
  return result;
}

/** Return the next required CI stage, or null after BUILD. */
export function nextCiStage(stage: CiStage): CiStage | null {
  const index = CI_STAGES.indexOf(stage);
  if (index < 0) throw new ValidationError('CI stage is invalid');
  return CI_STAGES[index + 1] ?? null;
}

/** Validate the embedded CI state, including fencing and contiguous results. */
export function assertCiExecutionState(
  deploymentStatus: DeploymentStatus,
  deploymentStage: DeploymentStage,
  ci: DeploymentCiExecution | undefined,
): void {
  if (ci === undefined) return; // Phase 2/3 deployments predate CI persistence.
  if (
    typeof ci !== 'object' ||
    ci === null ||
    !CI_EXECUTION_STATUSES.includes(ci.status) ||
    !Number.isSafeInteger(ci.attemptNumber) ||
    ci.attemptNumber < 0 ||
    !Number.isSafeInteger(ci.fence) ||
    ci.fence < 0 ||
    !Array.isArray(ci.stepResults) ||
    ci.stepResults.length > MAX_CI_STEP_RESULTS
  ) {
    throw new ValidationError('CI execution is invalid');
  }
  assertCiCleanupEvidence(ci.cleanup);
  assertCiFailure(ci.failure);
  const attemptRequired = ci.status !== 'NOT_STARTED';
  if (attemptRequired) {
    if (
      ci.attemptNumber < 1 ||
      ci.fence < 1 ||
      typeof ci.attemptId !== 'string' ||
      !UUID_PATTERN.test(ci.attemptId)
    ) {
      throw new ValidationError('CI execution fencing state is invalid');
    }
  } else if (
    ci.attemptNumber !== 0 ||
    ci.fence !== 0 ||
    ci.attemptId !== undefined ||
    ci.leaseExpiresAt !== undefined ||
    ci.heartbeatAt !== undefined ||
    ci.startedAt !== undefined ||
    ci.finishedAt !== undefined ||
    ci.failure !== undefined ||
    ci.cleanup !== undefined ||
    ci.stepResults.length !== 0
  ) {
    throw new ValidationError('not-started CI execution has runtime state');
  }
  for (const result of ci.stepResults) assertCiStepResult(result);
  for (let index = 0; index < ci.stepResults.length; index += 1) {
    const result = ci.stepResults[index];
    if (CI_STAGES[index] !== result.stage) {
      throw new ValidationError('CI step results must be contiguous');
    }
    if (result.attemptId !== ci.attemptId || result.fence !== ci.fence) {
      throw new ValidationError('CI step result fence does not match execution');
    }
  }
  const finalResult = ci.stepResults.at(-1);
  if (
    ci.cleanup !== undefined &&
    finalResult !== undefined &&
    ci.cleanup.completedAt.valueOf() < finalResult.finishedAt.valueOf()
  ) {
    throw new ValidationError('CI cleanup cannot precede the final step result');
  }
  if (
    ci.finishedAt !== undefined &&
    finalResult !== undefined &&
    ci.finishedAt.valueOf() < finalResult.finishedAt.valueOf()
  ) {
    throw new ValidationError('CI completion cannot precede the final step result');
  }
  if (
    ci.cleanup !== undefined &&
    ci.finishedAt !== undefined &&
    ci.cleanup.completedAt.valueOf() > ci.finishedAt.valueOf()
  ) {
    throw new ValidationError('CI cleanup cannot follow execution completion');
  }
  if (ci.status === 'NOT_STARTED') {
    if (deploymentStatus !== 'QUEUED' || deploymentStage !== 'QUEUED') {
      throw new ValidationError(
        'not-started CI execution has invalid deployment state',
      );
    }
    return;
  }
  if (!CI_STAGES.includes(deploymentStage as CiStage) && ci.status !== 'PASSED') {
    throw new ValidationError('CI execution stage is invalid');
  }
  if (ci.status === 'RUNNING') {
    if (
      deploymentStatus !== 'RUNNING' ||
      !CI_STAGES.includes(deploymentStage as CiStage) ||
      !isDate(ci.leaseExpiresAt) ||
      !isDate(ci.heartbeatAt) ||
      !isDate(ci.startedAt) ||
      ci.finishedAt !== undefined ||
      ci.failure !== undefined ||
      ci.cleanup !== undefined ||
      ci.stepResults.some((result) => result.status !== 'PASSED') ||
      ci.stepResults.length !== CI_STAGES.indexOf(deploymentStage as CiStage)
    ) {
      throw new ValidationError('running CI execution is invalid');
    }
  } else if (ci.status === 'RETRY_PENDING') {
    const lastResult = ci.stepResults.at(-1);
    if (
      deploymentStatus !== 'RUNNING' ||
      !CI_STAGES.includes(deploymentStage as CiStage) ||
      ci.leaseExpiresAt !== undefined ||
      ci.heartbeatAt !== undefined ||
      !isDate(ci.startedAt) ||
      ci.finishedAt !== undefined ||
      ci.failure === undefined ||
      ci.cleanup === undefined ||
      ci.stepResults.length !== CI_STAGES.indexOf(deploymentStage as CiStage) + 1 ||
      lastResult?.stage !== deploymentStage ||
      lastResult?.status === 'PASSED' ||
      lastResult.failure?.retryable !== true ||
      !sameFailure(ci.failure, lastResult.failure)
    ) {
      throw new ValidationError('retry-pending CI execution is invalid');
    }
  } else if (ci.status === 'PASSED') {
    const buildIndex = CI_STAGES.indexOf('BUILD');
    if (
      deploymentStatus !== 'RUNNING' ||
      stageOrder.get(deploymentStage) === undefined ||
      (stageOrder.get(deploymentStage) ?? -1) < stageOrder.get('BUILD')! ||
      ci.leaseExpiresAt !== undefined ||
      ci.heartbeatAt !== undefined ||
      !isDate(ci.startedAt) ||
      !isDate(ci.finishedAt) ||
      ci.failure !== undefined ||
      ci.cleanup?.status !== 'CLEANED' ||
      ci.stepResults.length !== buildIndex + 1 ||
      ci.stepResults.at(-1)?.stage !== 'BUILD' ||
      ci.stepResults.at(-1)?.status !== 'PASSED'
    ) {
      throw new ValidationError('passed CI execution is invalid');
    }
  } else {
    const lastResult = ci.stepResults.at(-1);
    if (
      deploymentStatus !== 'FAILED' ||
      !CI_STAGES.includes(deploymentStage as CiStage) ||
      ci.leaseExpiresAt !== undefined ||
      ci.heartbeatAt !== undefined ||
      !isDate(ci.startedAt) ||
      !isDate(ci.finishedAt) ||
      ci.failure === undefined ||
      ci.cleanup === undefined ||
      ci.stepResults.length === 0 ||
      ci.stepResults.length !== CI_STAGES.indexOf(deploymentStage as CiStage) + 1 ||
      lastResult?.stage !== deploymentStage ||
      lastResult?.status !== (ci.status === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED') ||
      ci.failure.retryable !== false ||
      !sameFailure(ci.failure, lastResult?.failure)
    ) {
      throw new ValidationError('failed CI execution is invalid');
    }
  }
}
