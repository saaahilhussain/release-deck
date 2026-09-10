import type { Collection, Db, Document, Filter, UpdateFilter } from 'mongodb';

import {
  createProject,
  createQueuedDeployment,
  createWebhookEvent,
  DEPLOYMENT_STAGES,
  DEPLOYMENT_STATUSES,
  transitionDeployment,
  type Deployment,
  type DeploymentCreateInput,
  type DeploymentTransition,
  type Project,
  type ProjectCreateInput,
  type Provider,
  type WebhookEvent,
  type WebhookEventCreateInput,
} from './domain.js';
import {
  ConcurrencyError,
  DomainError,
  DuplicateError,
  InvalidTransitionError,
  NotFoundError,
  PersistenceError,
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
  list(options?: PageOptions): Promise<Page<Project>>;
}

export interface DeploymentRepository {
  createQueued(input: DeploymentCreateInput): Promise<Deployment>;
  /** Compatibility alias for internal callers; new code should use createQueued. */
  create?(input: DeploymentCreateInput): Promise<Deployment>;
  findById(id: string): Promise<Deployment | null>;
  listByProject(projectId: string, options?: PageOptions): Promise<Page<Deployment>>;
  transition(id: string, transition: DeploymentTransition): Promise<Deployment>;
}

export interface WebhookEventRepository {
  create(input: WebhookEventCreateInput): Promise<WebhookEvent>;
  findByDeliveryId(
    deliveryId: string,
    provider?: Provider,
  ): Promise<WebhookEvent | null>;
}

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
    !Number.isSafeInteger(value.version)
  ) {
    throw new PersistenceError();
  }
  return {
    id: value._id,
    projectId: value.projectId,
    provider: value.provider,
    commitSha: value.commitSha,
    status: value.status as Deployment['status'],
    stage: value.stage as Deployment['stage'],
    version: value.version as number,
    createdAt: asDate(value.createdAt),
    updatedAt: asDate(value.updatedAt),
  };
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
  return {
    id: value._id,
    provider: value.provider,
    deliveryId: value.deliveryId,
    eventName: value.eventName,
    ...(typeof value.action === 'string' ? { action: value.action } : {}),
    metadata: { ...value.metadata },
    createdAt: asDate(value.createdAt),
  };
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
