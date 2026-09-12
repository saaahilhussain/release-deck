import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Router } from 'express';
import express from 'express';

import { ConcurrencyError } from '@releasedeck/db';
import type {
  WebhookEvent,
  WebhookEventCreateInput,
  WebhookIgnoredReason,
} from '@releasedeck/db';
import {
  BadRequestError,
  ConflictError,
  ServiceUnavailableError,
  UnauthorizedError,
  UnsupportedMediaTypeError,
  isDuplicateError,
} from './errors.js';
import type { ApiRepositories } from './services.js';

const MAX_BODY_BYTES = 1_048_576;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const ZERO_SHA = /^0{40}$/;
const DELIVERY_ID = /^[A-Za-z0-9_.-]{1,255}$/;
const EVENT_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export type WebhookProcessingStatus =
  'RECEIVED' | 'IGNORED' | 'QUEUE_PENDING' | 'QUEUED';

/** The queue package deliberately exposes only this API to the HTTP process. */
export interface DeploymentQueueProducer {
  enqueueDeployment(deploymentId: string): Promise<void>;
}

type Phase3WebhookEvent = WebhookEvent & {
  readonly payloadSha256: string;
  readonly ignoredReason?: WebhookIgnoredReason;
};

type Phase3WebhookCreateInput = WebhookEventCreateInput & {
  readonly payloadSha256: string;
};

export interface GithubWebhookOptions {
  readonly secret?: string;
  readonly queue?: DeploymentQueueProducer;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw new BadRequestError(`webhook field ${field} is invalid`);
  if (
    [...value].some(
      (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    )
  )
    throw new BadRequestError(`webhook field ${field} is invalid`);
  return value;
}

function normalizeCoordinate(value: string, field: string): string {
  const normalized = boundedString(value, field === 'owner' ? 39 : 100, field)
    .trim()
    .toLowerCase();
  const pattern =
    field === 'owner' ? /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/ : /^[a-z0-9._-]+$/;
  if (!pattern.test(normalized))
    throw new BadRequestError(`webhook field ${field} is invalid`);
  return normalized;
}

function headerValues(request: Request, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  return values;
}

function requiredHeaders(request: Request): {
  signature: string;
  deliveryId: string;
  eventName: string;
} {
  const signatures = headerValues(request, 'x-hub-signature-256');
  const deliveries = headerValues(request, 'x-github-delivery');
  const events = headerValues(request, 'x-github-event');
  if (signatures.length !== 1 || deliveries.length !== 1 || events.length !== 1)
    throw new UnauthorizedError();
  const signature = signatures[0]!;
  const deliveryId = deliveries[0]!;
  const eventName = events[0]!;
  if (
    !/^sha256=[0-9a-f]{64}$/i.test(signature) ||
    !DELIVERY_ID.test(deliveryId) ||
    !EVENT_NAME.test(eventName)
  )
    throw new UnauthorizedError();
  return { signature, deliveryId, eventName };
}

function verifySignature(
  raw: Buffer,
  signature: string,
  secret: string | undefined,
): void {
  if (!secret)
    throw new ServiceUnavailableError('webhook verification is not configured');
  const supplied = Buffer.from(signature.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new UnauthorizedError();
}

function parsePayload(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new BadRequestError('malformed JSON');
  }
}

interface PushDetails {
  owner: string;
  repository: string;
  ref: string;
  commitSha: string;
  deleted: boolean;
}

function parsePush(payload: unknown): PushDetails {
  if (!isRecord(payload)) throw new BadRequestError('push payload is invalid');
  const ref = boundedString(payload.ref, 1_000, 'ref');
  const deleted = payload.deleted;
  if (typeof deleted !== 'boolean')
    throw new BadRequestError('webhook field deleted is invalid');
  const repository = isRecord(payload.repository) ? payload.repository : undefined;
  if (!repository) throw new BadRequestError('webhook repository is invalid');
  let ownerValue: unknown;
  let repositoryValue: unknown;
  const fullName = repository.full_name;
  if (typeof fullName === 'string') {
    const parts = fullName.split('/');
    if (parts.length !== 2) throw new BadRequestError('webhook repository is invalid');
    [ownerValue, repositoryValue] = parts;
  } else {
    ownerValue = isRecord(repository.owner) ? repository.owner.login : undefined;
    repositoryValue = repository.name;
  }
  const owner = normalizeCoordinate(ownerValue as string, 'owner');
  const repositoryName = normalizeCoordinate(repositoryValue as string, 'repository');
  const after = boundedString(payload.after, 40, 'after').toLowerCase();
  if (!COMMIT_SHA.test(after))
    throw new BadRequestError('webhook field after is invalid');
  return { owner, repository: repositoryName, ref, commitSha: after, deleted };
}

function digest(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

function isSameDelivery(
  event: Phase3WebhookEvent,
  deliveryId: string,
  eventName: string,
  payloadSha256: string,
): boolean {
  return (
    event.deliveryId === deliveryId &&
    event.eventName === eventName &&
    typeof event.payloadSha256 === 'string' &&
    event.payloadSha256.toLowerCase() === payloadSha256
  );
}

function statusOf(event: Phase3WebhookEvent): WebhookProcessingStatus {
  return event.processingStatus;
}

function isConcurrencyError(error: unknown): boolean {
  return (
    error instanceof ConcurrencyError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'CONCURRENCY')
  );
}

export class GithubWebhookProcessor {
  private readonly repositories: ApiRepositories;
  private readonly queue: DeploymentQueueProducer;

  constructor(repositories: ApiRepositories, options: GithubWebhookOptions = {}) {
    this.repositories = repositories;
    this.queue = options.queue ?? {
      enqueueDeployment: async () => {
        throw new ServiceUnavailableError('deployment queue is not configured');
      },
    };
    this.secret = options.secret;
  }

  private readonly secret: string | undefined;

  async receive(request: Request): Promise<{ status: 202 | 204 }> {
    if (!request.is('application/json')) throw new UnsupportedMediaTypeError();
    const raw = request.body;
    if (!Buffer.isBuffer(raw)) throw new BadRequestError('webhook body is invalid');
    const headers = requiredHeaders(request);
    verifySignature(raw, headers.signature, this.secret);
    const payloadSha256 = digest(raw);
    const payload = parsePayload(raw);

    const existing = await this.repositories.webhookEvents.findByDeliveryId(
      headers.deliveryId,
      'github',
    );
    if (existing) {
      const phaseEvent = existing as Phase3WebhookEvent;
      if (
        !isSameDelivery(
          phaseEvent,
          headers.deliveryId,
          headers.eventName,
          payloadSha256,
        )
      )
        throw new ConflictError('delivery ID was reused with different content');
      return this.resume(phaseEvent);
    }

    if (headers.eventName !== 'push') {
      const event = await this.createEvent({
        deliveryId: headers.deliveryId,
        eventName: headers.eventName,
        payloadSha256,
        processingStatus: 'IGNORED',
        ignoredReason: 'unsupported_event',
      });
      const phaseEvent = event as Phase3WebhookEvent;
      return statusOf(phaseEvent) === 'IGNORED'
        ? { status: 204 }
        : this.resume(phaseEvent);
    }

    const push = parsePush(payload);
    const project = await this.repositories.projects.findByCoordinates(
      push.owner,
      push.repository,
      'github',
    );
    const reason = push.deleted
      ? 'deleted_ref'
      : ZERO_SHA.test(push.commitSha)
        ? 'invalid_payload'
        : project === null
          ? 'unknown_project'
          : push.ref !== `refs/heads/${project.defaultBranch}`
            ? 'non_default_branch'
            : undefined;
    if (reason) {
      const event = await this.createEvent({
        deliveryId: headers.deliveryId,
        eventName: headers.eventName,
        payloadSha256,
        processingStatus: 'IGNORED',
        ignoredReason: reason,
      });
      const phaseEvent = event as Phase3WebhookEvent;
      return statusOf(phaseEvent) === 'IGNORED'
        ? { status: 204 }
        : this.resume(phaseEvent);
    }

    const event = await this.createEvent({
      deliveryId: headers.deliveryId,
      eventName: headers.eventName,
      payloadSha256,
      processingStatus: 'RECEIVED',
      projectId: project!.id,
      commitSha: push.commitSha,
    });
    return this.resume(event as Phase3WebhookEvent);
  }

  private async createEvent(
    input: Phase3WebhookCreateInput,
  ): Promise<Phase3WebhookEvent> {
    try {
      return (await this.repositories.webhookEvents.create(
        input,
      )) as Phase3WebhookEvent;
    } catch (error) {
      if (!isDuplicateError(error)) throw error;
      const existing = await this.repositories.webhookEvents.findByDeliveryId(
        input.deliveryId,
        'github',
      );
      if (!existing) throw error;
      const phaseEvent = existing as Phase3WebhookEvent;
      if (
        !isSameDelivery(
          phaseEvent,
          input.deliveryId,
          input.eventName,
          input.payloadSha256,
        )
      )
        throw new ConflictError('delivery ID was reused with different content');
      return phaseEvent;
    }
  }

  private async resume(event: Phase3WebhookEvent): Promise<{ status: 202 | 204 }> {
    if (statusOf(event) === 'IGNORED') return { status: 204 };
    if (statusOf(event) === 'QUEUED') return { status: 202 };
    const pending = await this.ensureDeployment(event);
    if (statusOf(pending) === 'QUEUED') return { status: 202 };
    if (statusOf(pending) !== 'QUEUE_PENDING' || !pending.deploymentId)
      throw new ServiceUnavailableError('webhook delivery is pending reconciliation');
    try {
      await this.queue.enqueueDeployment(pending.deploymentId);
    } catch {
      // Mongo already contains QUEUE_PENDING; a retry or reconciliation pass
      // will retry the deterministic queue insertion.
      throw new ServiceUnavailableError('deployment queue is unavailable');
    }
    try {
      await this.repositories.webhookEvents.transition(pending.id, {
        expectedVersion: pending.version,
        processingStatus: 'QUEUED',
        deploymentId: pending.deploymentId,
      });
    } catch (error) {
      if (!isConcurrencyError(error)) throw error;
      let current: WebhookEvent | null;
      try {
        current = await this.repositories.webhookEvents.findByDeliveryId(
          pending.deliveryId,
          'github',
        );
      } catch {
        throw new ServiceUnavailableError('webhook delivery remains queue-pending');
      }
      const currentEvent = current as Phase3WebhookEvent | null;
      if (
        !currentEvent ||
        statusOf(currentEvent) !== 'QUEUED' ||
        currentEvent.deploymentId !== pending.deploymentId ||
        currentEvent.projectId !== pending.projectId ||
        currentEvent.commitSha !== pending.commitSha
      )
        throw error;
    }
    return { status: 202 };
  }

  private async ensureDeployment(
    event: Phase3WebhookEvent,
  ): Promise<Phase3WebhookEvent> {
    if (event.deploymentId && event.processingStatus === 'QUEUE_PENDING') return event;
    if (event.deploymentId && event.processingStatus === 'RECEIVED') {
      if (!event.projectId || !event.commitSha)
        throw new ServiceUnavailableError(
          'webhook delivery is missing deployment input',
        );
      return this.transitionOrReload(event, {
        expectedVersion: event.version,
        processingStatus: 'QUEUE_PENDING',
        projectId: event.projectId,
        commitSha: event.commitSha,
        deploymentId: event.deploymentId,
      });
    }
    const projectId = event.projectId;
    const commitSha = event.commitSha;
    if (!projectId || !commitSha)
      throw new ServiceUnavailableError('webhook delivery is missing deployment input');
    let deployment = await this.repositories.deployments.findBySourceWebhookEventId(
      event.id,
    );
    if (!deployment) {
      try {
        deployment = await this.repositories.deployments.createQueued({
          projectId,
          commitSha,
          provider: 'github',
          sourceWebhookEventId: event.id,
        });
      } catch (error) {
        if (!isDuplicateError(error)) throw error;
        deployment = await this.repositories.deployments.findBySourceWebhookEventId(
          event.id,
        );
      }
    }
    if (!deployment)
      throw new ServiceUnavailableError(
        'deployment creation is pending reconciliation',
      );
    return this.transitionOrReload(event, {
      expectedVersion: event.version,
      processingStatus:
        event.processingStatus === 'RECEIVED'
          ? 'QUEUE_PENDING'
          : event.processingStatus,
      ...(event.processingStatus === 'RECEIVED' ? { projectId, commitSha } : {}),
      deploymentId: deployment.id,
    });
  }

  private async transitionOrReload(
    event: Phase3WebhookEvent,
    transition: Parameters<ApiRepositories['webhookEvents']['transition']>[1],
  ): Promise<Phase3WebhookEvent> {
    try {
      return (await this.repositories.webhookEvents.transition(
        event.id,
        transition,
      )) as Phase3WebhookEvent;
    } catch (error) {
      if (!isConcurrencyError(error)) throw error;
      let current: WebhookEvent | null;
      try {
        current = await this.repositories.webhookEvents.findByDeliveryId(
          event.deliveryId,
          'github',
        );
      } catch {
        throw new ServiceUnavailableError('webhook delivery could not be reloaded');
      }
      if (!current) throw error;
      const currentEvent = current as Phase3WebhookEvent;
      const targetStatus = transition.processingStatus;
      const reachedTarget =
        currentEvent.processingStatus === targetStatus &&
        (transition.deploymentId === undefined ||
          currentEvent.deploymentId === transition.deploymentId) &&
        (transition.projectId === undefined ||
          currentEvent.projectId === transition.projectId) &&
        (transition.commitSha === undefined ||
          currentEvent.commitSha === transition.commitSha);
      if (!reachedTarget) throw error;
      return currentEvent;
    }
  }

  async reconcilePending(limit = 50): Promise<number> {
    const pending = await this.repositories.webhookEvents.listPending(
      Math.max(1, Math.min(100, limit)),
    );
    let processed = 0;
    for (const event of pending) {
      try {
        await this.resume(event as Phase3WebhookEvent);
        processed += 1;
      } catch {
        // Leave the durable QUEUE_PENDING/RECEIVED record for the next bounded pass.
      }
    }
    return processed;
  }
}

export function createGithubWebhookRouter(processor: GithubWebhookProcessor): Router {
  const router = express.Router();
  router.post('/', async (request, response) => {
    const result = await processor.receive(request);
    response.status(result.status).end();
  });
  return router;
}

export function githubWebhookRawBodyParser(): RequestHandler {
  return express.raw({ type: '*/*', limit: MAX_BODY_BYTES });
}
