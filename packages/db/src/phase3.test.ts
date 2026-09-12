import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConcurrencyError,
  DuplicateError,
  InvalidTransitionError,
  PersistenceError,
  ValidationError,
  createDomainRepositories,
  createWebhookEvent,
  DOMAIN_INDEXES,
  transitionWebhookEvent,
  type WebhookEvent,
} from './index.js';

type Stored = Record<string, unknown> & { _id: string };

function matches(document: Stored, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = document[key];
    if (expected && typeof expected === 'object' && '$in' in expected) {
      return (expected.$in as unknown[]).includes(actual);
    }
    if (expected && typeof expected === 'object' && '$exists' in expected) {
      return (expected.$exists as boolean) === (actual !== undefined);
    }
    return actual === expected;
  });
}

class FakeCollection {
  readonly documents: Stored[] = [];

  async insertOne(document: Stored): Promise<void> {
    if (
      this.documents.some(
        (existing) =>
          existing._id === document._id ||
          (document.sourceWebhookEventId !== undefined &&
            existing.sourceWebhookEventId === document.sourceWebhookEventId) ||
          (document.provider === 'github' &&
            existing.provider === 'github' &&
            document.deliveryId !== undefined &&
            existing.deliveryId === document.deliveryId),
      )
    ) {
      throw { code: 11000 };
    }
    this.documents.push({ ...document });
  }

  async findOne(filter: Record<string, unknown>): Promise<Stored | null> {
    return this.documents.find((document) => matches(document, filter)) ?? null;
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
  ): Promise<{ matchedCount: number }> {
    const document = this.documents.find((candidate) => matches(candidate, filter));
    if (!document) return { matchedCount: 0 };
    Object.assign(document, update.$set ?? {});
    for (const [key, value] of Object.entries(update.$inc ?? {})) {
      document[key] = Number(document[key]) + Number(value);
    }
    for (const key of Object.keys(update.$unset ?? {})) delete document[key];
    return { matchedCount: 1 };
  }

  find(filter: Record<string, unknown>) {
    const selected = this.documents.filter((document) => matches(document, filter));
    let sortSpec: Record<string, 1 | -1> = {};
    let take = selected.length;
    const chain = {
      sort: (spec: Record<string, 1 | -1>) => {
        sortSpec = spec;
        return chain;
      },
      limit: (limit: number) => {
        take = limit;
        return chain;
      },
      toArray: async () =>
        [...selected]
          .sort((left, right) => {
            for (const [key, direction] of Object.entries(sortSpec)) {
              const a = left[key] as string | Date;
              const b = right[key] as string | Date;
              const compared =
                a instanceof Date && b instanceof Date
                  ? a.valueOf() - b.valueOf()
                  : String(a).localeCompare(String(b));
              if (compared !== 0) return compared * direction;
            }
            return 0;
          })
          .slice(0, take),
    };
    return chain;
  }
}

function repositories() {
  const collections = new Map<string, FakeCollection>();
  const db = {
    collection(name: string) {
      const collection = collections.get(name) ?? new FakeCollection();
      collections.set(name, collection);
      return collection;
    },
  };
  return {
    repositories: createDomainRepositories(db as never),
    collections,
  };
}

const projectId = '01234567-89ab-4cde-8012-3456789abcde';
const eventId = '11111111-1111-4111-8111-111111111111';
const deploymentId = '22222222-2222-4222-8222-222222222222';
const sha = '0123456789abcdef0123456789abcdef01234567';
const digest = 'a'.repeat(64);

test('webhook state combinations and transitions are strict and guarded', () => {
  const received = createWebhookEvent({
    deliveryId: 'delivery-1',
    eventName: 'push',
    payloadSha256: digest,
    projectId,
    commitSha: sha,
  });
  assert.equal(received.processingStatus, 'RECEIVED');
  assert.throws(
    () =>
      createWebhookEvent({
        deliveryId: 'delivery-2',
        eventName: 'push',
        processingStatus: 'QUEUE_PENDING',
        projectId,
        commitSha: sha,
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      createWebhookEvent({
        deliveryId: 'delivery-ignored-without-digest',
        eventName: 'ping',
        processingStatus: 'IGNORED',
        ignoredReason: 'unsupported_event',
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      transitionWebhookEvent(received, {
        expectedVersion: 1,
        processingStatus: 'QUEUE_PENDING',
        projectId,
        commitSha: sha,
      }),
    ValidationError,
  );

  const pending = transitionWebhookEvent(received, {
    expectedVersion: 1,
    processingStatus: 'QUEUE_PENDING',
    projectId,
    commitSha: sha,
    deploymentId,
  });
  const queued = transitionWebhookEvent(pending, {
    expectedVersion: 2,
    processingStatus: 'QUEUED',
  });
  assert.equal(queued.version, 3);
  assert.equal(queued.deploymentId, deploymentId);
  assert.throws(
    () =>
      transitionWebhookEvent(pending, {
        expectedVersion: 1,
        processingStatus: 'QUEUED',
      }),
    InvalidTransitionError,
  );
});

test('project coordinates and webhook-linked deployment sources normalize and deduplicate', async () => {
  const { repositories: repos, collections } = repositories();
  const project = await repos.projects.create({
    owner: 'Acme',
    repository: 'Release-Deck',
  });
  assert.equal(
    (await repos.projects.findByCoordinates(' ACME ', ' RELEASE-DECK '))?.id,
    project.id,
  );

  const first = await repos.deployments.createQueued({
    projectId: project.id,
    commitSha: sha.toUpperCase(),
    sourceWebhookEventId: eventId,
  });
  assert.equal(first.commitSha, sha);
  assert.equal(
    (await repos.deployments.findBySourceWebhookEventId(eventId))?.id,
    first.id,
  );
  await assert.rejects(
    repos.deployments.createQueued({
      projectId: project.id,
      commitSha: sha,
      sourceWebhookEventId: eventId,
    }),
    DuplicateError,
  );

  const deploymentCollection = collections.get('deployments');
  assert.ok(deploymentCollection);
  const stored = deploymentCollection.documents.find(
    (document) => document._id === first.id,
  );
  assert.ok(stored);
  stored.status = 'SUCCESS';
  stored.stage = 'CHECKOUT';
  await assert.rejects(repos.deployments.findById(first.id), PersistenceError);
});

test('webhook repository applies CAS transitions and maps invalid persisted states safely', async () => {
  const { repositories: repos, collections } = repositories();
  const event = await repos.webhookEvents.create({
    deliveryId: 'delivery-cas',
    eventName: 'push',
    payloadSha256: digest,
    projectId,
    commitSha: sha,
  });
  const pending = await repos.webhookEvents.transition(event.id, {
    expectedVersion: 1,
    processingStatus: 'QUEUE_PENDING',
    projectId,
    commitSha: sha,
    deploymentId,
  });
  assert.equal(pending.version, 2);
  await assert.rejects(
    repos.webhookEvents.transition(event.id, {
      expectedVersion: 1,
      processingStatus: 'QUEUED',
    }),
    ConcurrencyError,
  );
  const queued = await repos.webhookEvents.transition(event.id, {
    expectedVersion: 2,
    processingStatus: 'QUEUED',
  });
  assert.equal(queued.processingStatus, 'QUEUED');

  const webhookCollection = collections.get('webhookEvents');
  assert.ok(webhookCollection);
  webhookCollection.documents.push({
    _id: '33333333-3333-4333-8333-333333333333',
    provider: 'github',
    deliveryId: 'invalid-state',
    eventName: 'push',
    metadata: {},
    processingStatus: 'QUEUE_PENDING',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await assert.rejects(
    repos.webhookEvents.findByDeliveryId('invalid-state'),
    PersistenceError,
  );
});

test('pending webhook listing has a hard bound and deterministic ordering', async () => {
  const { repositories: repos } = repositories();
  const first = await repos.webhookEvents.create({
    deliveryId: 'pending-1',
    eventName: 'push',
    payloadSha256: digest,
    projectId,
    commitSha: sha,
  });
  const second = await repos.webhookEvents.create({
    deliveryId: 'pending-2',
    eventName: 'push',
    payloadSha256: digest,
    projectId,
    commitSha: sha,
  });
  await repos.webhookEvents.create({
    deliveryId: 'legacy-not-recoverable',
    eventName: 'push',
  });
  await repos.webhookEvents.transition(first.id, {
    expectedVersion: 1,
    processingStatus: 'QUEUE_PENDING',
    projectId,
    commitSha: sha,
    deploymentId,
  });
  const pending = await repos.webhookEvents.listPending(1);
  assert.equal(pending.length, 1);
  const allPending = await repos.webhookEvents.listPending(2);
  assert.deepEqual(
    (await repos.webhookEvents.listPending(2)).map((item) => item.id),
    allPending.map((item) => item.id),
  );
  assert.ok(allPending.some((item) => item.id === first.id));
  assert.ok(allPending.some((item) => item.id === second.id));
  await assert.rejects(repos.webhookEvents.listPending(101), ValidationError);
});

test('deployment source and webhook pending indexes are declared', () => {
  const sourceIndex = DOMAIN_INDEXES.deployments.find(
    (index) => index.name === 'deployments_source_webhook_event_unique',
  );
  assert.equal(sourceIndex?.unique, true);
  assert.deepEqual(sourceIndex?.partialFilterExpression, {
    sourceWebhookEventId: { $type: 'string' },
  });
  assert.equal(
    DOMAIN_INDEXES.webhookEvents.some(
      (index) => index.name === 'webhook_events_processing_updated_id',
    ),
    true,
  );
});

test('legacy webhook records map to RECEIVED with safe defaults', () => {
  const event = createWebhookEvent({ deliveryId: 'legacy', eventName: 'push' });
  assert.equal(event.processingStatus, 'RECEIVED');
  assert.equal(event.version, 1);
  assert.ok(event.updatedAt instanceof Date);
  const typed: WebhookEvent = event;
  assert.equal(typed.processingStatus, 'RECEIVED');
});
