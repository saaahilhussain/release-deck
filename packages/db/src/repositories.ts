import type { Collection, Db, Document, Filter, UpdateFilter } from 'mongodb';
import { randomUUID } from 'node:crypto';

import {
  createProject,
  createQueuedDeployment,
  createWebhookEvent,
  assertDeploymentState,
  assertCiExecutionState,
  createCiStepResult,
  assertWebhookEventState,
  normalizeProjectCoordinates,
  DEPLOYMENT_STAGES,
  DEPLOYMENT_STATUSES,
  transitionDeployment,
  transitionWebhookEvent,
  DEFAULT_CI_LEASE_MS,
  MAX_CI_LEASE_MS,
  CI_STAGES,
  type CiExecutionClaim,
  type CiExecutionLeaseInput,
  type CiStepOutcomeInput,
  type DeploymentCiExecution,
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

export interface CiExecutionClaimOptions {
  readonly now?: Date;
  readonly leaseMs?: number;
}

export interface CiExecutionReclaimOptions {
  readonly now?: Date;
  readonly leaseMs?: number;
}

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
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_CI_LEASE_MS) {
    throw new ValidationError('CI lease duration is invalid');
  }
  return leaseMs;
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
