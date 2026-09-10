import type {
  Deployment,
  DeploymentCreateInput,
  DeploymentRepository as DbDeploymentRepository,
  Page,
  PageOptions,
  Project,
  ProjectCreateInput,
  ProjectRepository as DbProjectRepository,
  WebhookEvent,
  WebhookEventCreateInput,
  WebhookEventRepository as DbWebhookEventRepository,
} from '@releasedeck/db';
import {
  ConflictError,
  isDuplicateError,
  isNotFoundError,
  NotFoundError,
} from './errors.js';
import type {
  ListQuery,
  QueuedDeploymentInput,
  WebhookMetadataInput,
} from './schemas.js';

export type ProjectRecord = Project;
export type DeploymentRecord = Deployment;
export type WebhookEventRecord = WebhookEvent;
export type CursorPage<T> = Page<T>;
export type ProjectRepository = DbProjectRepository;
export type DeploymentRepository = DbDeploymentRepository;
export type WebhookEventRepository = DbWebhookEventRepository;

export interface ApiRepositories {
  projects: ProjectRepository;
  deployments: DeploymentRepository;
  webhookEvents: WebhookEventRepository;
}

export class ProjectService {
  constructor(private readonly repository: ProjectRepository) {}

  async create(input: ProjectCreateInput): Promise<ProjectRecord> {
    try {
      return await this.repository.create(input);
    } catch (error) {
      if (isDuplicateError(error)) throw new ConflictError('project already exists');
      throw error;
    }
  }

  list(query: ListQuery): Promise<CursorPage<ProjectRecord>> {
    return this.repository.list(query as PageOptions);
  }

  async get(id: string): Promise<ProjectRecord> {
    try {
      const project = await this.repository.findById(id);
      if (!project) throw new NotFoundError('project was not found');
      return project;
    } catch (error) {
      if (isNotFoundError(error)) throw new NotFoundError('project was not found');
      throw error;
    }
  }
}

export class DeploymentService {
  constructor(
    private readonly repository: DeploymentRepository,
    private readonly projects: ProjectRepository,
  ) {}

  async createQueued(input: QueuedDeploymentInput): Promise<DeploymentRecord> {
    const project = await this.projects.findById(input.projectId);
    if (!project) throw new NotFoundError('project was not found');
    try {
      return await this.repository.createQueued(input as DeploymentCreateInput);
    } catch (error) {
      if (isDuplicateError(error)) throw new ConflictError('deployment already exists');
      throw error;
    }
  }

  async get(id: string): Promise<DeploymentRecord> {
    const deployment = await this.repository.findById(id);
    if (!deployment) throw new NotFoundError('deployment was not found');
    return deployment;
  }

  async listByProject(
    projectId: string,
    query: ListQuery,
  ): Promise<CursorPage<DeploymentRecord>> {
    const project = await this.projects.findById(projectId);
    if (!project) throw new NotFoundError('project was not found');
    return this.repository.listByProject(projectId, query as PageOptions);
  }
}

export class WebhookEventService {
  constructor(private readonly repository: WebhookEventRepository) {}

  async record(input: WebhookMetadataInput): Promise<WebhookEventRecord> {
    try {
      const createInput: WebhookEventCreateInput = {
        deliveryId: input.deliveryId,
        eventName: input.eventName,
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      };
      return await this.repository.create(createInput);
    } catch (error) {
      if (isDuplicateError(error))
        throw new ConflictError('webhook event already exists');
      throw error;
    }
  }
}
