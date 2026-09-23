import type { Collection, Db, Document, Filter, UpdateFilter } from 'mongodb';
import { randomUUID } from 'node:crypto';

import {
  createProject,
  createQueuedDeployment,
  createWebhookEvent,
  assertDeploymentState,
  assertCiExecutionState,
  assertReleaseExecutionState,
  assertCiOutcomeCleanup,
  createCiStepResult,
  nextCiStage,
  assertWebhookEventState,
  normalizeProjectCoordinates,
  DEPLOYMENT_STAGES,
  DEPLOYMENT_STATUSES,
  transitionDeployment,
  transitionWebhookEvent,
  DEFAULT_CI_LEASE_MS,
  MIN_CI_LEASE_MS,
  MAX_CI_LEASE_MS,
  DEFAULT_RELEASE_LEASE_MS,
  MIN_RELEASE_LEASE_MS,
  MAX_RELEASE_LEASE_MS,
  CI_STAGES,
  type CiExecutionClaim,
  type CiExecutionLeaseInput,
  type CiStepOutcomeInput,
  type DeploymentCiExecution,
  type DeploymentReleaseExecution,
  type ReleaseExecutionClaim,
  type ReleaseExecutionClaimOptions,
  type ReleaseExecutionLeaseInput,
  type ReleaseSuccessInput,
  type ReleaseFailureInput,
  type DeploymentStage,
  type DeploymentStatus,
  type Deployment,
  type DeploymentCreateInput,
  type DeploymentTransition,
  type Project,
  type ProjectCreateInput,
  type Provider,
  type WebhookEvent,
  type WebhookEventCreateInput,
  type WebhookEventTransition,
  WEBHOOK_PROCESSING_STATUSES,
} from './domain.js';
import {
  ConcurrencyError,
  DomainError,
  DuplicateError,
  InvalidTransitionError,
  NotFoundError,
  PersistenceError,
  ValidationError,
} from './errors.js';
import {
  decodeCursor,
  encodeCursor,
  pageSize,
  type Page,
  type PageOptions,
} from './pagination.js';

interface StoredBase {
  _id: string;
  createdAt: Date;
}
type StoredProject = Project & StoredBase;
type StoredDeployment = Deployment & StoredBase;
type StoredWebhookEvent = WebhookEvent & StoredBase;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const REPOSITORY_PATTERN = /^[a-z0-9._-]+$/;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export interface ProjectRepository {
  create(input: ProjectCreateInput): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  findByCoordinates(
    owner: string,
    repository: string,
    provider?: Provider,
  ): Promise<Project | null>;
  list(options?: PageOptions): Promise<Page<Project>>;
}

export interface DeploymentRepository {
  createQueued(input: DeploymentCreateInput): Promise<Deployment>;
  /** Compatibility alias for internal callers; new code should use createQueued. */
  create?(input: DeploymentCreateInput): Promise<Deployment>;
  findById(id: string): Promise<Deployment | null>;
  findBySourceWebhookEventId(sourceWebhookEventId: string): Promise<Deployment | null>;
  listByProject(projectId: string, options?: PageOptions): Promise<Page<Deployment>>;
  transition(id: string, transition: DeploymentTransition): Promise<Deployment>;
  claimCiExecution?(
    id: string,
    options?: CiExecutionClaimOptions,
  ): Promise<CiExecutionClaim | null>;
  reclaimExpiredCiExecution?(
    id: string,
    options?: CiExecutionReclaimOptions,
  ): Promise<CiExecutionClaim | null>;
  renewCiExecution?(
    id: string,
    lease: CiExecutionLeaseInput,
    now?: Date,
  ): Promise<Deployment>;
  recordCiStepOutcome?(
    id: string,
    outcome: CiStepOutcomeInput,
    now?: Date,
  ): Promise<Deployment>;
  claimReleaseExecution?(
    id: string,
    options?: ReleaseExecutionClaimOptions,
  ): Promise<ReleaseExecutionClaim | null>;
  reclaimExpiredReleaseExecution?(
    id: string,
    options?: ReleaseExecutionClaimOptions,
  ): Promise<ReleaseExecutionClaim | null>;
  renewReleaseExecution?(
    id: string,
    lease: ReleaseExecutionLeaseInput,
    now?: Date,
  ): Promise<Deployment>;
  recordReleaseSuccess?(
    id: string,
    outcome: ReleaseSuccessInput,
    now?: Date,
  ): Promise<Deployment>;
  recordReleaseFailure?(
    id: string,
    outcome: ReleaseFailureInput,
    now?: Date,
  ): Promise<Deployment>;
}

export interface CiExecutionClaimOptions {
  readonly now?: Date;
  readonly leaseMs?: number;
}

export interface CiExecutionReclaimOptions {
  readonly now?: Date;
  readonly leaseMs?: number;
}

/** Complete CI-capable repository contract; the base contract keeps Phase 2 mocks source-compatible. */
export interface CiDeploymentRepository {
  claimCiExecution(
    id: string,
    options?: CiExecutionClaimOptions,
  ): Promise<CiExecutionClaim | null>;
  reclaimExpiredCiExecution(
    id: string,
    options?: CiExecutionReclaimOptions,
  ): Promise<CiExecutionClaim | null>;
  renewCiExecution(
    id: string,
    lease: CiExecutionLeaseInput,
    now?: Date,
  ): Promise<Deployment>;
  recordCiStepOutcome(
    id: string,
    outcome: CiStepOutcomeInput,
    now?: Date,
  ): Promise<Deployment>;
}

export type DeploymentRepositoryWithCi = DeploymentRepository & CiDeploymentRepository;

export interface ReleaseDeploymentRepository {
  claimReleaseExecution(
    id: string,
    options?: ReleaseExecutionClaimOptions,
  ): Promise<ReleaseExecutionClaim | null>;
  reclaimExpiredReleaseExecution(
    id: string,
    options?: ReleaseExecutionClaimOptions,
  ): Promise<ReleaseExecutionClaim | null>;
  renewReleaseExecution(
    id: string,
    lease: ReleaseExecutionLeaseInput,
    now?: Date,
  ): Promise<Deployment>;
  recordReleaseSuccess(
    id: string,
    outcome: ReleaseSuccessInput,
    now?: Date,
  ): Promise<Deployment>;
  recordReleaseFailure(
    id: string,
    outcome: ReleaseFailureInput,
    now?: Date,
  ): Promise<Deployment>;
}

export type DeploymentRepositoryWithRelease = DeploymentRepository &
  ReleaseDeploymentRepository;
export type DeploymentRepositoryWithCiAndRelease = DeploymentRepositoryWithCi &
  ReleaseDeploymentRepository;

export interface WebhookEventRepository {
  create(input: WebhookEventCreateInput): Promise<WebhookEvent>;
  findByDeliveryId(
    deliveryId: string,
    provider?: Provider,
  ): Promise<WebhookEvent | null>;
  transition(id: string, transition: WebhookEventTransition): Promise<WebhookEvent>;
  listPending(limit?: number): Promise<readonly WebhookEvent[]>;
}

export const WEBHOOK_PENDING_MAX = 100;

export interface DomainRepositories {
  readonly projects: ProjectRepository;
  readonly deployments: DeploymentRepository;
  readonly webhookEvents: WebhookEventRepository;
}

function mapMongoError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  ) {
    throw new DuplicateError();
  }
  throw new PersistenceError();
}

function asDate(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf()))
    throw new PersistenceError();
  return value;
}

function ciNow(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new ValidationError('CI timestamp is invalid');
  }
  return now;
}

function ciLeaseMs(value: number | undefined): number {
  const leaseMs = value ?? DEFAULT_CI_LEASE_MS;
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < MIN_CI_LEASE_MS ||
    leaseMs > MAX_CI_LEASE_MS
  ) {
    throw new ValidationError('CI lease duration is invalid');
  }
  return leaseMs;
}

function releaseNow(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf()))
    throw new ValidationError('release timestamp is invalid');
  return now;
}
function releaseLeaseMs(value: number | undefined): number {
  const ms = value ?? DEFAULT_RELEASE_LEASE_MS;
  if (
    !Number.isSafeInteger(ms) ||
    ms < MIN_RELEASE_LEASE_MS ||
    ms > MAX_RELEASE_LEASE_MS
  )
    throw new ValidationError('release lease duration is invalid');
  return ms;
}

function ciTokenValid(attemptId: string, fence: number): boolean {
  return UUID_PATTERN.test(attemptId) && Number.isSafeInteger(fence) && fence >= 1;
}

function projectFromDocument(document: Document): Project {
  const value = document as Partial<StoredProject>;
  if (
    typeof value._id !== 'string' ||
    !UUID_PATTERN.test(value._id) ||
    value.provider !== 'github' ||
    typeof value.owner !== 'string' ||
    value.owner.length > 39 ||
    !OWNER_PATTERN.test(value.owner) ||
    typeof value.repository !== 'string' ||
    value.repository.length > 100 ||
    !REPOSITORY_PATTERN.test(value.repository) ||
    typeof value.defaultBranch !== 'string' ||
    value.defaultBranch.length === 0 ||
    value.defaultBranch.length > 255 ||
    containsControlCharacter(value.defaultBranch)
  ) {
    throw new PersistenceError();
  }
  return {
    id: value._id,
    provider: value.provider,
    owner: value.owner,
    repository: value.repository,
    defaultBranch: value.defaultBranch,
    createdAt: asDate(value.createdAt),
    updatedAt: asDate(value.updatedAt),
  };
}

function deploymentFromDocument(document: Document): Deployment {
  const value = document as Partial<StoredDeployment>;
  if (
    typeof value._id !== 'string' ||
    !UUID_PATTERN.test(value._id) ||
    typeof value.projectId !== 'string' ||
    !UUID_PATTERN.test(value.projectId) ||
    value.provider !== 'github' ||
    typeof value.commitSha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.commitSha) ||
    typeof value.status !== 'string' ||
    !DEPLOYMENT_STATUSES.includes(value.status as Deployment['status']) ||
    typeof value.stage !== 'string' ||
    !DEPLOYMENT_STAGES.includes(value.stage as Deployment['stage']) ||
    !Number.isSafeInteger(value.version) ||
    (value.sourceWebhookEventId !== undefined &&
      (typeof value.sourceWebhookEventId !== 'string' ||
        !UUID_PATTERN.test(value.sourceWebhookEventId)))
  ) {
    throw new PersistenceError();
  }
  const record: Deployment = {
    id: value._id,
    projectId: value.projectId,
    provider: value.provider,
    commitSha: value.commitSha,
    status: value.status as Deployment['status'],
    stage: value.stage as Deployment['stage'],
    version: value.version as number,
    ...(value.sourceWebhookEventId === undefined
      ? {}
      : { sourceWebhookEventId: value.sourceWebhookEventId }),
    ...(value.ci === undefined ? {} : { ci: value.ci as DeploymentCiExecution }),
    ...(value.release === undefined
      ? {}
      : { release: value.release as DeploymentReleaseExecution }),
    createdAt: asDate(value.createdAt),
    updatedAt: asDate(value.updatedAt),
  };
  try {
    assertDeploymentState(record.status, record.stage);
    if (
      value.ci !== undefined &&
      (typeof value.ci !== 'object' || value.ci === null || Array.isArray(value.ci))
    ) {
      throw new ValidationError('CI execution is invalid');
    }
    assertCiExecutionState(record.status, record.stage, record.ci);
    assertReleaseExecutionState(
      record.id,
      record.commitSha,
      record.status,
      record.stage,
      record.release,
    );
  } catch {
    throw new PersistenceError();
  }
  return record;
}

function webhookFromDocument(document: Document): WebhookEvent {
  const value = document as Partial<StoredWebhookEvent>;
  if (
    typeof value._id !== 'string' ||
    !UUID_PATTERN.test(value._id) ||
    value.provider !== 'github' ||
    typeof value.deliveryId !== 'string' ||
    value.deliveryId.length === 0 ||
    value.deliveryId.length > 255 ||
    containsControlCharacter(value.deliveryId) ||
    typeof value.eventName !== 'string' ||
    value.eventName.length === 0 ||
    value.eventName.length > 100 ||
    containsControlCharacter(value.eventName) ||
    (value.action !== undefined &&
      (typeof value.action !== 'string' ||
        value.action.length === 0 ||
        value.action.length > 100 ||
        containsControlCharacter(value.action))) ||
    !value.metadata ||
    typeof value.metadata !== 'object' ||
    Array.isArray(value.metadata) ||
    Object.entries(value.metadata).length > 20 ||
    Object.entries(value.metadata).some(
      ([key, entry]) =>
        key.length === 0 ||
        key.length > 100 ||
        containsControlCharacter(key) ||
        typeof entry !== 'string' ||
        entry.length > 500 ||
        containsControlCharacter(entry),
    )
  ) {
    throw new PersistenceError();
  }
  const processingStatus = value.processingStatus ?? 'RECEIVED';
  if (!WEBHOOK_PROCESSING_STATUSES.includes(processingStatus)) {
    throw new PersistenceError();
  }
  const version = value.version ?? 1;
  const updatedAt = value.updatedAt ?? value.createdAt;
  if (
    typeof value.payloadSha256 !== 'undefined' &&
    (typeof value.payloadSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(value.payloadSha256))
  ) {
    throw new PersistenceError();
  }
  if (value.ignoredReason !== undefined && typeof value.ignoredReason !== 'string') {
    throw new PersistenceError();
  }
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !updatedAt
  ) {
    throw new PersistenceError();
  }
  const optionalUuid = (field: unknown): boolean =>
    field === undefined || (typeof field === 'string' && UUID_PATTERN.test(field));
  if (
    !optionalUuid(value.projectId) ||
    !optionalUuid(value.deploymentId) ||
    (value.commitSha !== undefined &&
      (typeof value.commitSha !== 'string' || !/^[0-9a-f]{40}$/.test(value.commitSha)))
  ) {
    throw new PersistenceError();
  }
  const ignoredReason =
    typeof value.ignoredReason === 'string'
      ? (value.ignoredReason as NonNullable<WebhookEvent['ignoredReason']>)
      : undefined;
  const record: WebhookEvent = {
    id: value._id,
    provider: value.provider,
    deliveryId: value.deliveryId,
    eventName: value.eventName,
    ...(typeof value.action === 'string' ? { action: value.action } : {}),
    metadata: { ...value.metadata },
    ...(typeof value.payloadSha256 === 'string'
      ? { payloadSha256: value.payloadSha256.toLowerCase() }
      : {}),
    processingStatus,
    version,
    updatedAt: asDate(updatedAt),
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.commitSha === 'string' ? { commitSha: value.commitSha } : {}),
    ...(typeof value.deploymentId === 'string'
      ? { deploymentId: value.deploymentId }
      : {}),
    ...(ignoredReason === undefined ? {} : { ignoredReason }),
    createdAt: asDate(value.createdAt),
  };
  try {
    assertWebhookEventState(record);
  } catch {
    throw new PersistenceError();
  }
  return record;
}

function listFilter(
  position: ReturnType<typeof decodeCursor> | undefined,
): Filter<Document> {
  if (!position) return {};
  return {
    $or: [
      { createdAt: { $lt: position.createdAt } },
      {
        createdAt: position.createdAt,
        _id: { $lt: position.id },
      } as unknown as Filter<Document>,
    ],
  };
}

async function newestFirstPage<TDocument extends Document, TRecord>(
  collection: Collection<TDocument>,
  baseFilter: Filter<TDocument>,
  options: PageOptions | undefined,
  map: (document: TDocument) => TRecord,
): Promise<Page<TRecord>> {
  const limit = pageSize(options);
  const position =
    options?.cursor !== undefined ? decodeCursor(options.cursor) : undefined;
  const filter = { ...baseFilter, ...listFilter(position) } as Filter<TDocument>;
  try {
    const documents = await collection
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = documents.length > limit;
    const pageDocuments = hasMore ? documents.slice(0, limit) : documents;
    const items = pageDocuments.map((document) => map(document as TDocument));
    const last = pageDocuments.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: asDate(last.createdAt), id: String(last._id) })
          : null,
    };
  } catch (error) {
    mapMongoError(error);
  }
}

function documentFor(record: Project | Deployment | WebhookEvent): Document {
  const { id, ...value } = record;
  return { _id: id, ...value };
}

function createProjectsRepository(
  collection: Collection<StoredProject>,
): ProjectRepository {
  return {
    async create(input) {
      const record = createProject(input);
      try {
        await collection.insertOne(documentFor(record) as StoredProject);
        return record;
      } catch (error) {
        mapMongoError(error);
      }
    },
    async findById(id) {
      try {
        const document = await collection.findOne({ _id: id });
        return document ? projectFromDocument(document) : null;
      } catch (error) {
        mapMongoError(error);
      }
    },
    async findByCoordinates(owner, repository, provider = 'github') {
      if (provider !== 'github') throw new PersistenceError();
      const { owner: normalizedOwner, repository: normalizedRepository } =
        normalizeProjectCoordinates({ owner, repository });
      try {
        const document = await collection.findOne({
          provider,
          owner: normalizedOwner,
          repository: normalizedRepository,
        });
        return document ? projectFromDocument(document) : null;
      } catch (error) {
        mapMongoError(error);
      }
    },
    list(options) {
      return newestFirstPage(collection, {}, options, projectFromDocument);
    },
  };
}

function createDeploymentsRepository(
  collection: Collection<StoredDeployment>,
): DeploymentRepository {
  const createQueued = async (input: DeploymentCreateInput): Promise<Deployment> => {
    const record = createQueuedDeployment(input);
    try {
      await collection.insertOne(documentFor(record) as StoredDeployment);
      return record;
    } catch (error) {
      mapMongoError(error);
    }
  };

  const updateCiDeployment = async (
    current: Deployment,
    next: Deployment,
    extraFilter: Document,
  ): Promise<boolean> => {
    const result = await collection.updateOne(
      { _id: current.id, version: current.version, ...extraFilter },
      {
        $set: {
          status: next.status,
          stage: next.stage,
          ci: next.ci as DeploymentCiExecution,
          updatedAt: next.updatedAt,
        },
        $inc: { version: 1 },
      },
    );
    return result.matchedCount === 1;
  };

  const claim = async (
    id: string,
    options: CiExecutionClaimOptions | undefined,
    reclaimOnly: boolean,
  ): Promise<CiExecutionClaim | null> => {
    try {
      const now = ciNow(options?.now);
      const leaseMs = ciLeaseMs(options?.leaseMs);
      if (!UUID_PATTERN.test(id)) throw new ValidationError('deployment ID is invalid');
      const currentDocument = await collection.findOne({ _id: id });
      if (!currentDocument) throw new NotFoundError();
      const current = deploymentFromDocument(currentDocument);
      const existing = current.ci;
      if (existing?.status === 'RUNNING') {
        if (
          !reclaimOnly ||
          existing.leaseExpiresAt === undefined ||
          existing.leaseExpiresAt.valueOf() > now.valueOf()
        ) {
          return null;
        }
      } else if (reclaimOnly) {
        return null;
      }
      if (
        current.status === 'SUCCESS' ||
        current.status === 'FAILED' ||
        current.status === 'ROLLED_BACK' ||
        existing?.status === 'PASSED' ||
        existing?.status === 'FAILED' ||
        existing?.status === 'TIMED_OUT'
      ) {
        return null;
      }
      const isQueued = current.status === 'QUEUED' && current.stage === 'QUEUED';
      const isLegacyRunning =
        existing === undefined &&
        current.status === 'RUNNING' &&
        CI_STAGES.includes(current.stage as (typeof CI_STAGES)[number]);
      const retrying = existing?.status === 'RETRY_PENDING';
      if (
        !isQueued &&
        !isLegacyRunning &&
        !retrying &&
        existing?.status !== 'NOT_STARTED' &&
        !reclaimOnly
      ) {
        return null;
      }
      if (reclaimOnly && existing?.status !== 'RUNNING') return null;
      const attemptId = randomUUID();
      const fence = (existing?.fence ?? 0) + 1;
      const attemptNumber = (existing?.attemptNumber ?? 0) + 1;
      // Each attempt receives a disposable workspace and therefore always starts
      // from checkout, including recovery after a crash at a later step.
      const stage = 'CHECKOUT' as (typeof CI_STAGES)[number];
      if (!CI_STAGES.includes(stage)) return null;
      const ci: DeploymentCiExecution = {
        status: 'RUNNING',
        attemptNumber,
        fence,
        attemptId,
        leaseExpiresAt: new Date(now.valueOf() + leaseMs),
        heartbeatAt: now,
        startedAt: now,
        stepResults: [],
      };
      const next: Deployment = {
        ...current,
        status: isQueued ? 'RUNNING' : current.status,
        stage,
        ci,
        version: current.version + 1,
        updatedAt: now,
      };
      assertDeploymentState(next.status, next.stage);
      assertCiExecutionState(next.status, next.stage, ci);
      const tokenFilter: Document = existing
        ? {
            'ci.status': existing.status,
            'ci.fence': existing.fence,
            ...(existing.attemptId === undefined
              ? {}
              : { 'ci.attemptId': existing.attemptId }),
            ...(reclaimOnly ? { 'ci.leaseExpiresAt': { $lte: now } } : {}),
          }
        : { ci: { $exists: false } };
      if (!(await updateCiDeployment(current, next, tokenFilter))) return null;
      return {
        attemptId,
        fence,
        attemptNumber,
        leaseExpiresAt: ci.leaseExpiresAt!,
        deployment: next,
      };
    } catch (error) {
      mapMongoError(error);
    }
  };

  const renew = async (
    id: string,
    lease: CiExecutionLeaseInput,
    nowInput: Date | undefined,
  ): Promise<Deployment> => {
    try {
      const now = ciNow(nowInput);
      const leaseMs = ciLeaseMs(lease.leaseMs);
      if (
        !UUID_PATTERN.test(id) ||
        !Number.isSafeInteger(lease.expectedVersion) ||
        lease.expectedVersion < 1 ||
        !ciTokenValid(lease.attemptId, lease.fence)
      ) {
        throw new ValidationError('CI lease token is invalid');
      }
      const document = await collection.findOne({ _id: id });
      if (!document) throw new NotFoundError();
      const current = deploymentFromDocument(document);
      const existing = current.ci;
      if (
        lease.expectedVersion !== current.version ||
        existing?.status !== 'RUNNING' ||
        existing.attemptId !== lease.attemptId.toLowerCase() ||
        existing.fence !== lease.fence ||
        existing.leaseExpiresAt === undefined ||
        existing.leaseExpiresAt.valueOf() <= now.valueOf()
      ) {
        throw new ConcurrencyError();
      }
      const ci: DeploymentCiExecution = {
        ...existing,
        leaseExpiresAt: new Date(now.valueOf() + leaseMs),
        heartbeatAt: now,
      };
      const next: Deployment = {
        ...current,
        ci,
        version: current.version + 1,
        updatedAt: now,
      };
      assertCiExecutionState(next.status, next.stage, ci);
      if (
        !(await updateCiDeployment(current, next, {
          'ci.status': 'RUNNING',
          'ci.attemptId': lease.attemptId.toLowerCase(),
          'ci.fence': lease.fence,
          'ci.leaseExpiresAt': { $gt: now },
        }))
      ) {
        throw new ConcurrencyError();
      }
      return next;
    } catch (error) {
      mapMongoError(error);
    }
  };

  const sameResult = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left, (_key, value: unknown) =>
      value instanceof Date ? value.toISOString() : value,
    ) ===
    JSON.stringify(right, (_key, value: unknown) =>
      value instanceof Date ? value.toISOString() : value,
    );

  const recordOutcome = async (
    id: string,
    outcome: CiStepOutcomeInput,
    nowInput: Date | undefined,
  ): Promise<Deployment> => {
    try {
      const now = ciNow(nowInput);
      if (
        !UUID_PATTERN.test(id) ||
        !Number.isSafeInteger(outcome.expectedVersion) ||
        outcome.expectedVersion < 1 ||
        !ciTokenValid(outcome.attemptId, outcome.fence)
      ) {
        throw new ValidationError('CI outcome token is invalid');
      }
      const document = await collection.findOne({ _id: id });
      if (!document) throw new NotFoundError();
      const current = deploymentFromDocument(document);
      const existing = current.ci;
      if (
        existing?.attemptId !== outcome.attemptId.toLowerCase() ||
        existing.fence !== outcome.fence
      ) {
        throw new ConcurrencyError();
      }
      const prior = existing.stepResults.find(
        (result) => result.stage === outcome.stage,
      );
      const normalized = createCiStepResult(outcome.attemptId, outcome.fence, outcome);
      assertCiOutcomeCleanup(outcome.stage, normalized.status, outcome.cleanup);
      if (prior !== undefined) {
        if (
          sameResult(prior, normalized) &&
          (normalized.status === 'PASSED' && outcome.stage !== 'BUILD'
            ? true
            : sameResult(current.ci?.cleanup, outcome.cleanup))
        ) {
          return current;
        }
        throw new ConcurrencyError();
      }
      if (
        existing.status !== 'RUNNING' ||
        outcome.expectedVersion !== current.version ||
        existing.leaseExpiresAt === undefined ||
        existing.leaseExpiresAt.valueOf() <= now.valueOf() ||
        current.stage !== outcome.stage
      ) {
        throw new ConcurrencyError();
      }
      const stageIndex = CI_STAGES.indexOf(outcome.stage);
      if (stageIndex < 0 || existing.stepResults.length !== stageIndex) {
        throw new InvalidTransitionError('CI steps must be recorded contiguously');
      }
      const stepResults = [...existing.stepResults, normalized];
      let status: DeploymentStatus = current.status;
      let stage: DeploymentStage = current.stage;
      let ciStatus: DeploymentCiExecution['status'] = 'RUNNING';
      let failure: DeploymentCiExecution['failure'];
      let leaseExpiresAt: Date | undefined = existing.leaseExpiresAt;
      let heartbeatAt: Date | undefined = now;
      let finishedAt: Date | undefined;
      let cleanup: DeploymentCiExecution['cleanup'];
      if (normalized.status === 'PASSED') {
        const nextStage = nextCiStage(outcome.stage);
        if (nextStage === null) {
          ciStatus = 'PASSED';
          leaseExpiresAt = undefined;
          heartbeatAt = undefined;
          finishedAt = now;
          cleanup = outcome.cleanup;
        } else {
          stage = nextStage;
        }
      } else if (normalized.failure!.retryable) {
        ciStatus = 'RETRY_PENDING';
        failure = normalized.failure;
        leaseExpiresAt = undefined;
        heartbeatAt = undefined;
        cleanup = outcome.cleanup;
      } else {
        status = 'FAILED';
        ciStatus = normalized.status === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED';
        failure = normalized.failure;
        leaseExpiresAt = undefined;
        heartbeatAt = undefined;
        finishedAt = now;
        cleanup = outcome.cleanup;
      }
      const ci = { ...existing, status: ciStatus, stepResults } as {
        -readonly [Key in keyof DeploymentCiExecution]?: DeploymentCiExecution[Key];
      };
      if (leaseExpiresAt === undefined) delete ci.leaseExpiresAt;
      else ci.leaseExpiresAt = leaseExpiresAt;
      if (heartbeatAt === undefined) delete ci.heartbeatAt;
      else ci.heartbeatAt = heartbeatAt;
      if (finishedAt === undefined) delete ci.finishedAt;
      else ci.finishedAt = finishedAt;
      if (failure === undefined) delete ci.failure;
      else ci.failure = failure;
      if (cleanup === undefined) delete ci.cleanup;
      else ci.cleanup = cleanup;
      const nextCi = ci as DeploymentCiExecution;
      const next: Deployment = {
        ...current,
        status,
        stage,
        ci: nextCi,
        version: current.version + 1,
        updatedAt: now,
      };
      assertDeploymentState(next.status, next.stage);
      assertCiExecutionState(next.status, next.stage, nextCi);
      if (
        !(await updateCiDeployment(current, next, {
          'ci.status': 'RUNNING',
          'ci.attemptId': outcome.attemptId.toLowerCase(),
          'ci.fence': outcome.fence,
          'ci.leaseExpiresAt': { $gt: now },
        }))
      ) {
        throw new ConcurrencyError();
      }
      return next;
    } catch (error) {
      mapMongoError(error);
    }
  };

  const updateRelease = async (
    current: Deployment,
    next: Deployment,
    extra: Document,
  ): Promise<boolean> => {
    const result = await collection.updateOne(
      { _id: current.id, version: current.version, ...extra },
      {
        $set: {
          status: next.status,
          stage: next.stage,
          release: next.release as DeploymentReleaseExecution,
          ...(next.ci === undefined ? {} : { ci: next.ci }),
          updatedAt: next.updatedAt,
        },
        $inc: { version: 1 },
      },
    );
    return result.matchedCount === 1;
  };
  const claimRelease = async (
    id: string,
    options: ReleaseExecutionClaimOptions | undefined,
    reclaimOnly: boolean,
  ): Promise<ReleaseExecutionClaim | null> => {
    try {
      const now = releaseNow(options?.now);
      const leaseMs = releaseLeaseMs(options?.leaseMs);
      if (!UUID_PATTERN.test(id)) throw new ValidationError('deployment ID is invalid');
      const document = await collection.findOne({ _id: id });
      if (!document) throw new NotFoundError();
      const current = deploymentFromDocument(document);
      const existing = current.release;
      if (existing?.status === 'RUNNING') {
        if (
          !reclaimOnly ||
          !existing.leaseExpiresAt ||
          existing.leaseExpiresAt.valueOf() > now.valueOf()
        )
          return null;
      } else if (reclaimOnly) return null;
      const ciPassed =
        current.ci?.status === 'PASSED' &&
        current.stage === 'BUILD' &&
        current.status === 'RUNNING';
      const reclaiming =
        reclaimOnly &&
        existing?.status === 'RUNNING' &&
        current.stage === 'DEPLOY' &&
        current.status === 'RUNNING';
      const retrying =
        existing?.status === 'RETRY_PENDING' &&
        current.stage === 'DEPLOY' &&
        current.status === 'RUNNING';
      if (
        (!ciPassed && !retrying && !reclaiming) ||
        existing?.status === 'DEPLOYED' ||
        existing?.status === 'FAILED'
      )
        return null;
      if (reclaimOnly && existing?.status !== 'RUNNING') return null;
      const attemptId = randomUUID();
      const fence = (existing?.fence ?? 0) + 1;
      const attemptNumber = (existing?.attemptNumber ?? 0) + 1;
      const release: DeploymentReleaseExecution = {
        status: 'RUNNING',
        releaseId: current.id,
        attemptNumber,
        fence,
        attemptId,
        leaseExpiresAt: new Date(now.valueOf() + leaseMs),
        heartbeatAt: now,
        startedAt: now,
      };
      const next: Deployment = {
        ...current,
        stage: 'DEPLOY',
        release,
        version: current.version + 1,
        updatedAt: now,
      };
      assertDeploymentState(next.status, next.stage);
      assertCiExecutionState(next.status, next.stage, next.ci);
      assertReleaseExecutionState(
        next.id,
        next.commitSha,
        next.status,
        next.stage,
        release,
      );
      const filter: Document = existing
        ? {
            'release.status': existing.status,
            'release.fence': existing.fence,
            ...(existing.attemptId ? { 'release.attemptId': existing.attemptId } : {}),
            ...(reclaimOnly ? { 'release.leaseExpiresAt': { $lte: now } } : {}),
          }
        : { release: { $exists: false }, 'ci.status': 'PASSED' };
      if (!(await updateRelease(current, next, filter))) return null;
      return {
        attemptId,
        fence,
        attemptNumber,
        leaseExpiresAt: release.leaseExpiresAt!,
        deployment: next,
      };
    } catch (error) {
      mapMongoError(error);
    }
  };
  const renewRelease = async (
    id: string,
    lease: ReleaseExecutionLeaseInput,
    nowInput?: Date,
  ): Promise<Deployment> => {
    try {
      const now = releaseNow(nowInput);
      const leaseMs = releaseLeaseMs(lease.leaseMs);
      if (
        !UUID_PATTERN.test(id) ||
        !Number.isSafeInteger(lease.expectedVersion) ||
        lease.expectedVersion < 1 ||
        !ciTokenValid(lease.attemptId, lease.fence)
      )
        throw new ValidationError('release lease token is invalid');
      const document = await collection.findOne({ _id: id });
      if (!document) throw new NotFoundError();
      const current = deploymentFromDocument(document);
      const existing = current.release;
      if (
        lease.expectedVersion !== current.version ||
        existing?.status !== 'RUNNING' ||
        existing.attemptId !== lease.attemptId.toLowerCase() ||
        existing.fence !== lease.fence ||
        !existing.leaseExpiresAt ||
        existing.leaseExpiresAt.valueOf() <= now.valueOf()
      )
        throw new ConcurrencyError();
      const release = {
        ...existing,
        leaseExpiresAt: new Date(now.valueOf() + leaseMs),
        heartbeatAt: now,
      };
      const next = {
        ...current,
        release,
        version: current.version + 1,
        updatedAt: now,
      };
      assertReleaseExecutionState(
        next.id,
        next.commitSha,
        next.status,
        next.stage,
        release,
      );
      if (
        !(await updateRelease(current, next, {
          'release.status': 'RUNNING',
          'release.attemptId': lease.attemptId.toLowerCase(),
          'release.fence': lease.fence,
          'release.leaseExpiresAt': { $gt: now },
        }))
      )
        throw new ConcurrencyError();
      return next;
    } catch (error) {
      mapMongoError(error);
    }
  };
  const recordReleaseSuccess = async (
    id: string,
    outcome: ReleaseSuccessInput,
    nowInput?: Date,
  ): Promise<Deployment> => {
    try {
      const now = releaseNow(nowInput);
      if (
        !UUID_PATTERN.test(id) ||
        !Number.isSafeInteger(outcome.expectedVersion) ||
        outcome.expectedVersion < 1 ||
        !ciTokenValid(outcome.attemptId, outcome.fence)
      )
        throw new ValidationError('release success token is invalid');
      const document = await collection.findOne({ _id: id });
      if (!document) throw new NotFoundError();
      const current = deploymentFromDocument(document);
      const existing = current.release;
      if (
        outcome.expectedVersion !== current.version ||
        existing?.status !== 'RUNNING' ||
        existing.attemptId !== outcome.attemptId.toLowerCase() ||
        existing.fence !== outcome.fence ||
        !existing.leaseExpiresAt ||
        existing.leaseExpiresAt.valueOf() <= now.valueOf()
      )
        throw new ConcurrencyError();
      const proof = {
        ...outcome.proof,
        releaseId: outcome.proof.releaseId.trim().toLowerCase(),
        commitSha: outcome.proof.commitSha.trim().toLowerCase(),
      };
      const releaseBase = { ...existing } as {
        -readonly [
          K in keyof DeploymentReleaseExecution
        ]?: DeploymentReleaseExecution[K];
      };
      delete releaseBase.leaseExpiresAt;
      delete releaseBase.heartbeatAt;
      delete releaseBase.failure;
      const release = {
        ...releaseBase,
        releaseId: existing.releaseId,
        attemptNumber: existing.attemptNumber,
        fence: existing.fence,
        status: 'DEPLOYED' as const,
        finishedAt: now,
        success: proof,
      } as DeploymentReleaseExecution;
      const next = {
        ...current,
        status: 'SUCCESS' as const,
        stage: 'COMPLETE' as const,
        release,
        version: current.version + 1,
        updatedAt: now,
      };
      assertCiExecutionState(next.status, next.stage, next.ci);
      assertReleaseExecutionState(
        next.id,
        next.commitSha,
        next.status,
        next.stage,
        release,
      );
      if (
        !(await updateRelease(current, next, {
          'release.status': 'RUNNING',
          'release.attemptId': outcome.attemptId.toLowerCase(),
          'release.fence': outcome.fence,
          'release.leaseExpiresAt': { $gt: now },
        }))
      )
        throw new ConcurrencyError();
      return next;
    } catch (error) {
      mapMongoError(error);
    }
  };
  const recordReleaseFailure = async (
    id: string,
    outcome: ReleaseFailureInput,
    nowInput?: Date,
  ): Promise<Deployment> => {
    try {
      const now = releaseNow(nowInput);
      if (
        !UUID_PATTERN.test(id) ||
        !Number.isSafeInteger(outcome.expectedVersion) ||
        outcome.expectedVersion < 1 ||
        !ciTokenValid(outcome.attemptId, outcome.fence)
      )
        throw new ValidationError('release failure token is invalid');
      const document = await collection.findOne({ _id: id });
      if (!document) throw new NotFoundError();
      const current = deploymentFromDocument(document);
      const existing = current.release;
      if (
        outcome.expectedVersion !== current.version ||
        existing?.status !== 'RUNNING' ||
        existing.attemptId !== outcome.attemptId.toLowerCase() ||
        existing.fence !== outcome.fence ||
        !existing.leaseExpiresAt ||
        existing.leaseExpiresAt.valueOf() <= now.valueOf()
      )
        throw new ConcurrencyError();
      const failure = outcome.failure;
      const releaseBase = { ...existing } as {
        -readonly [
          K in keyof DeploymentReleaseExecution
        ]?: DeploymentReleaseExecution[K];
      };
      delete releaseBase.leaseExpiresAt;
      delete releaseBase.heartbeatAt;
      delete releaseBase.success;
      delete releaseBase.finishedAt;
      const release = {
        ...releaseBase,
        releaseId: existing.releaseId,
        attemptNumber: existing.attemptNumber,
        fence: existing.fence,
        status: failure.retryable ? ('RETRY_PENDING' as const) : ('FAILED' as const),
        ...(failure.retryable ? {} : { finishedAt: now }),
        failure,
      } as DeploymentReleaseExecution;
      const next = failure.retryable
        ? { ...current, release, version: current.version + 1, updatedAt: now }
        : {
            ...current,
            status: 'FAILED' as const,
            stage: 'DEPLOY' as const,
            release,
            version: current.version + 1,
            updatedAt: now,
          };
      assertCiExecutionState(next.status, next.stage, next.ci);
      assertReleaseExecutionState(
        next.id,
        next.commitSha,
        next.status,
        next.stage,
        release,
      );
      if (
        !(await updateRelease(current, next, {
          'release.status': 'RUNNING',
          'release.attemptId': outcome.attemptId.toLowerCase(),
          'release.fence': outcome.fence,
          'release.leaseExpiresAt': { $gt: now },
        }))
      )
        throw new ConcurrencyError();
      return next;
    } catch (error) {
      mapMongoError(error);
    }
  };

  return {
    createQueued,
    create: createQueued,
    async findById(id) {
      try {
        const document = await collection.findOne({ _id: id });
        return document ? deploymentFromDocument(document) : null;
      } catch (error) {
        mapMongoError(error);
      }
    },
    async findBySourceWebhookEventId(sourceWebhookEventId) {
      if (!UUID_PATTERN.test(sourceWebhookEventId))
        throw new ValidationError('source webhook event ID is invalid');
      try {
        const document = await collection.findOne({ sourceWebhookEventId });
        return document ? deploymentFromDocument(document) : null;
      } catch (error) {
        mapMongoError(error);
      }
    },
    listByProject(projectId, options) {
      return newestFirstPage(
        collection,
        { projectId },
        options,
        deploymentFromDocument,
      );
    },
    async transition(id, requested) {
      if (
        !Number.isSafeInteger(requested.expectedVersion) ||
        requested.expectedVersion < 1
      ) {
        throw new PersistenceError();
      }
      try {
        const currentDocument = await collection.findOne({ _id: id });
        if (!currentDocument) throw new NotFoundError();
        const current = deploymentFromDocument(currentDocument);
        if (requested.expectedVersion !== current.version) throw new ConcurrencyError();
        const next = transitionDeployment(current, requested);
        assertCiExecutionState(next.status, next.stage, next.ci);
        const update: UpdateFilter<StoredDeployment> = {
          $set: { status: next.status, stage: next.stage, updatedAt: next.updatedAt },
          $inc: { version: 1 },
        };
        const result = await collection.updateOne(
          { _id: id, version: requested.expectedVersion },
          update,
        );
        if (result.matchedCount !== 1) throw new ConcurrencyError();
        return next;
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof ConcurrencyError)
          throw error;
        if (error instanceof InvalidTransitionError) throw error;
        mapMongoError(error);
      }
    },
    claimCiExecution: (id, options) => claim(id, options, false),
    reclaimExpiredCiExecution: (id, options) => claim(id, options, true),
    renewCiExecution: renew,
    recordCiStepOutcome: recordOutcome,
    claimReleaseExecution: (id, options) => claimRelease(id, options, false),
    reclaimExpiredReleaseExecution: (id, options) => claimRelease(id, options, true),
    renewReleaseExecution: renewRelease,
    recordReleaseSuccess,
    recordReleaseFailure,
  };
}

function createWebhookEventsRepository(
  collection: Collection<StoredWebhookEvent>,
): WebhookEventRepository {
  return {
    async create(input) {
      const record = createWebhookEvent(input);
      try {
        await collection.insertOne(documentFor(record) as StoredWebhookEvent);
        return record;
      } catch (error) {
        mapMongoError(error);
      }
    },
    async findByDeliveryId(deliveryId, provider: Provider = 'github') {
      try {
        const document = await collection.findOne({ provider, deliveryId });
        return document ? webhookFromDocument(document) : null;
      } catch (error) {
        mapMongoError(error);
      }
    },
    async transition(id, requested) {
      if (!UUID_PATTERN.test(id)) throw new PersistenceError();
      try {
        const currentDocument = await collection.findOne({ _id: id });
        if (!currentDocument) throw new NotFoundError();
        const current = webhookFromDocument(currentDocument);
        if (requested.expectedVersion !== current.version) throw new ConcurrencyError();
        const next = transitionWebhookEvent(current, requested);
        const set: Document = {
          processingStatus: next.processingStatus,
          updatedAt: next.updatedAt,
        };
        const unset: Document = {};
        if (next.projectId === undefined) unset.projectId = '';
        else set.projectId = next.projectId;
        if (next.commitSha === undefined) unset.commitSha = '';
        else set.commitSha = next.commitSha;
        if (next.deploymentId === undefined) unset.deploymentId = '';
        else set.deploymentId = next.deploymentId;
        if (next.ignoredReason === undefined) unset.ignoredReason = '';
        else set.ignoredReason = next.ignoredReason;
        const update: UpdateFilter<StoredWebhookEvent> = {
          $set: set,
          $inc: { version: 1 },
          ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }),
        };
        const result = await collection.updateOne(
          { _id: id, version: requested.expectedVersion },
          update,
        );
        if (result.matchedCount !== 1) throw new ConcurrencyError();
        return next;
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof ConcurrencyError)
          throw error;
        if (error instanceof InvalidTransitionError) throw error;
        mapMongoError(error);
      }
    },
    async listPending(limit = 25) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > WEBHOOK_PENDING_MAX) {
        throw new ValidationError('pending webhook limit must be between 1 and 100');
      }
      try {
        const documents = await collection
          .find({
            processingStatus: { $in: ['RECEIVED', 'QUEUE_PENDING'] },
            payloadSha256: { $exists: true },
          })
          .sort({ updatedAt: 1, createdAt: 1, _id: 1 })
          .limit(limit)
          .toArray();
        return documents.map(webhookFromDocument);
      } catch (error) {
        mapMongoError(error);
      }
    },
  };
}

export function createDomainRepositories(db: Db): DomainRepositories {
  return {
    projects: createProjectsRepository(db.collection<StoredProject>('projects')),
    deployments: createDeploymentsRepository(
      db.collection<StoredDeployment>('deployments'),
    ),
    webhookEvents: createWebhookEventsRepository(
      db.collection<StoredWebhookEvent>('webhookEvents'),
    ),
  };
}
