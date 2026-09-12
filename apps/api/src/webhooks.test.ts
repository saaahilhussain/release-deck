import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import test from 'node:test';

import { createLogger } from '@releasedeck/runtime';
import type { ApiRepositories } from './services.js';
import { createApp } from './app.js';
import { GithubWebhookProcessor } from './webhooks.js';

const projectId = '01234567-89ab-4cde-8012-3456789abcde';
const deploymentId = 'fedcba98-7654-4321-8fed-cba987654321';
const eventId = '11111111-1111-4111-8111-111111111111';
const sha = '0123456789abcdef0123456789abcdef01234567';
const secret = 'phase-3-test-secret';
const project = {
  id: projectId,
  provider: 'github' as const,
  owner: 'example',
  repository: 'releasedeck',
  defaultBranch: 'main',
  createdAt: new Date(),
  updatedAt: new Date(),
};

type Event = {
  id: string;
  provider: 'github';
  deliveryId: string;
  eventName: string;
  metadata: Record<string, string>;
  payloadSha256: string;
  processingStatus: 'RECEIVED' | 'IGNORED' | 'QUEUE_PENDING' | 'QUEUED';
  version: number;
  updatedAt: Date;
  createdAt: Date;
  projectId?: string;
  commitSha?: string;
  deploymentId?: string;
  ignoredReason?:
    | 'unsupported_event'
    | 'unknown_project'
    | 'non_default_branch'
    | 'deleted_ref'
    | 'invalid_payload';
};

function repositories(): {
  repositories: ApiRepositories;
  events: Event[];
  deployments: {
    id: string;
    projectId: string;
    commitSha: string;
    sourceWebhookEventId?: string;
  }[];
} {
  const events: Event[] = [];
  const deployments: {
    id: string;
    projectId: string;
    commitSha: string;
    sourceWebhookEventId?: string;
  }[] = [];
  const repositories = {
    projects: {
      create: async () => project,
      findById: async (id: string) => (id === projectId ? project : null),
      findByCoordinates: async (owner: string, repository: string) =>
        owner === project.owner && repository === project.repository ? project : null,
      list: async () => ({ items: [project], nextCursor: null }),
    },
    deployments: {
      createQueued: async (input: {
        projectId: string;
        commitSha: string;
        sourceWebhookEventId?: string;
      }) => {
        const created = { id: deploymentId, ...input };
        deployments.push(created);
        return {
          ...created,
          provider: 'github' as const,
          status: 'QUEUED' as const,
          stage: 'QUEUED' as const,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      findById: async () => null,
      findBySourceWebhookEventId: async (id: string) => {
        const found = deployments.find(
          (deployment) => deployment.sourceWebhookEventId === id,
        );
        return found
          ? {
              ...found,
              provider: 'github' as const,
              status: 'QUEUED' as const,
              stage: 'QUEUED' as const,
              version: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : null;
      },
      listByProject: async () => ({ items: [], nextCursor: null }),
      transition: async () => {
        throw new Error('not used');
      },
    },
    webhookEvents: {
      create: async (
        input: Omit<
          Event,
          'id' | 'provider' | 'metadata' | 'version' | 'createdAt' | 'updatedAt'
        > & {
          deliveryId: string;
          eventName: string;
          metadata?: Record<string, string>;
        },
      ) => {
        const event: Event = {
          id: eventId,
          provider: 'github',
          deliveryId: input.deliveryId,
          eventName: input.eventName,
          metadata: input.metadata ?? {},
          payloadSha256: input.payloadSha256,
          processingStatus: input.processingStatus ?? 'RECEIVED',
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.commitSha ? { commitSha: input.commitSha } : {}),
          ...(input.ignoredReason ? { ignoredReason: input.ignoredReason } : {}),
        };
        events.push(event);
        return event;
      },
      findByDeliveryId: async (deliveryId: string) =>
        events.find((event) => event.deliveryId === deliveryId) ?? null,
      listPending: async () =>
        events.filter(
          (event) =>
            event.processingStatus === 'RECEIVED' ||
            event.processingStatus === 'QUEUE_PENDING',
        ),
      transition: async (
        id: string,
        input: {
          expectedVersion: number;
          processingStatus: Event['processingStatus'];
          projectId?: string;
          commitSha?: string;
          deploymentId?: string;
        },
      ) => {
        const event = events.find((candidate) => candidate.id === id)!;
        if (event.version !== input.expectedVersion) throw new Error('stale');
        event.version += 1;
        event.updatedAt = new Date();
        event.processingStatus = input.processingStatus;
        Object.assign(
          event,
          input.projectId ? { projectId: input.projectId } : {},
          input.commitSha ? { commitSha: input.commitSha } : {},
          input.deploymentId ? { deploymentId: input.deploymentId } : {},
        );
        return event;
      },
    },
  } as unknown as ApiRepositories;
  return { repositories, events, deployments };
}

function pushPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ref: 'refs/heads/main',
    after: sha,
    deleted: false,
    repository: { full_name: 'Example/ReleaseDeck' },
    ...overrides,
  });
}

async function withApi(
  repos: ApiRepositories,
  queue: { enqueueDeployment(id: string): Promise<void> },
  assertion: (url: string) => Promise<void>,
): Promise<void> {
  const server = createApp({
    mongo: { ping: async () => undefined },
    redis: { ping: async () => undefined },
    logger: createLogger('silent'),
    repositories: repos,
    githubWebhookSecret: secret,
    deploymentQueue: queue,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  try {
    await assertion(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function headers(
  body: string,
  delivery = 'delivery-1',
  signatureBody = body,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-github-delivery': delivery,
    'x-github-event': 'push',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(signatureBody).digest('hex')}`,
  };
}

async function postWithRawHeaders(
  url: string,
  rawHeaders: readonly string[],
  body: string,
): Promise<number> {
  const target = new URL(url);
  const socket = createConnection(Number(target.port), target.hostname);
  await once(socket, 'connect');
  const headerLines: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    headerLines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
  }
  socket.write(
    [
      `POST ${target.pathname} HTTP/1.1`,
      `Host: ${target.host}`,
      ...headerLines,
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'),
  );
  let response = '';
  for await (const chunk of socket) response += chunk.toString();
  const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
  if (!match) throw new Error('expected HTTP response');
  return Number(match[1]);
}

test('webhook authenticates exact raw bytes, queues one deployment, and is idempotent', async () => {
  const state = repositories();
  const queued: string[] = [];
  await withApi(
    state.repositories,
    {
      enqueueDeployment: async (id) => {
        queued.push(id);
      },
    },
    async (url) => {
      const body = pushPayload();
      const first = await fetch(`${url}/api/webhooks/github`, {
        method: 'POST',
        headers: headers(body),
        body,
      });
      assert.equal(first.status, 202);
      const duplicate = await fetch(`${url}/api/webhooks/github`, {
        method: 'POST',
        headers: headers(body),
        body,
      });
      assert.equal(duplicate.status, 202);
      assert.deepEqual(queued, [deploymentId]);
      assert.equal(state.events.length, 1);
      assert.equal(state.deployments.length, 1);

      const alteredBody = JSON.stringify(JSON.parse(body), null, 2);
      const altered = await fetch(`${url}/api/webhooks/github`, {
        method: 'POST',
        headers: headers(body, 'delivery-2', body),
        body: alteredBody,
      });
      assert.equal(altered.status, 401);
    },
  );
});

test('signed unsupported, unknown, branch, deleted, and zero-SHA pushes are durably ignored', async () => {
  for (const [delivery, event, override] of [
    ['unsupported', 'ping', {}],
    ['unknown', 'push', { repository: { full_name: 'other/project' } }],
    ['branch', 'push', { ref: 'refs/heads/dev' }],
    ['deleted', 'push', { deleted: true }],
    ['zero', 'push', { after: '0'.repeat(40) }],
  ] as const) {
    const state = repositories();
    const queued: string[] = [];
    await withApi(
      state.repositories,
      {
        enqueueDeployment: async (id) => {
          queued.push(id);
        },
      },
      async (url) => {
        const body =
          event === 'push' ? pushPayload(override) : JSON.stringify({ hello: 'world' });
        const response = await fetch(`${url}/api/webhooks/github`, {
          method: 'POST',
          headers: { ...headers(body, delivery), 'x-github-event': event },
          body,
        });
        assert.equal(response.status, 204);
        assert.equal(state.events.length, 1);
        assert.equal(state.events[0]!.processingStatus, 'IGNORED');
        assert.deepEqual(queued, []);
      },
    );
  }
});

test('webhook validates media type, headers, and JSON before processing', async () => {
  const state = repositories();
  await withApi(
    state.repositories,
    { enqueueDeployment: async () => undefined },
    async (url) => {
      const noHeader = await fetch(`${url}/api/webhooks/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(noHeader.status, 401);
      const media = await fetch(`${url}/api/webhooks/github`, {
        method: 'POST',
        headers: { ...headers('{}'), 'content-type': 'text/plain' },
        body: '{}',
      });
      assert.equal(media.status, 415);
      const malformedBody = '{';
      const malformed = await fetch(`${url}/api/webhooks/github`, {
        method: 'POST',
        headers: headers(malformedBody),
        body: malformedBody,
      });
      assert.equal(malformed.status, 400);
      assert.equal(state.events.length, 0);
    },
  );
});

test('non-concurrency transition failures are not mistaken for a successful race', async () => {
  const state = repositories();
  (
    state.repositories.webhookEvents as unknown as {
      transition: () => Promise<never>;
    }
  ).transition = async () => {
    throw new Error('persistence failure');
  };
  await withApi(
    state.repositories,
    { enqueueDeployment: async () => undefined },
    async (url) => {
      const body = pushPayload();
      const response = await fetch(`${url}/api/webhooks/github`, {
        method: 'POST',
        headers: headers(body),
        body,
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: { code: 'INTERNAL_ERROR', message: 'internal server error' },
      });
    },
  );
});

test('a delivery ID cannot be reused with different signed content', async () => {
  const state = repositories();
  await withApi(
    state.repositories,
    { enqueueDeployment: async () => undefined },
    async (url) => {
      const firstBody = pushPayload();
      const first = await fetch(`${url}/api/webhooks/github`, {
        method: 'POST',
        headers: headers(firstBody, 'reused-delivery'),
        body: firstBody,
      });
      assert.equal(first.status, 202);

      const conflictingBody = pushPayload({ after: 'a'.repeat(40) });
      const conflict = await fetch(`${url}/api/webhooks/github`, {
        method: 'POST',
        headers: headers(conflictingBody, 'reused-delivery'),
        body: conflictingBody,
      });
      assert.equal(conflict.status, 409);
      assert.equal(state.events.length, 1);
      assert.equal(state.deployments.length, 1);
    },
  );
});

test('a queue outage leaves durable pending work that a redelivery resumes', async () => {
  const state = repositories();
  let available = false;
  const queued: string[] = [];
  await withApi(
    state.repositories,
    {
      enqueueDeployment: async (id) => {
        if (!available) throw new Error('queue unavailable');
        queued.push(id);
      },
    },
    async (url) => {
      const body = pushPayload();
      const first = await fetch(`${url}/api/webhooks/github`, {
        method: 'POST',
        headers: headers(body, 'queue-recovery'),
        body,
      });
      assert.equal(first.status, 503);
      assert.equal(state.events[0]?.processingStatus, 'QUEUE_PENDING');
      assert.equal(state.deployments.length, 1);

      available = true;
      const retried = await fetch(`${url}/api/webhooks/github`, {
        method: 'POST',
        headers: headers(body, 'queue-recovery'),
        body,
      });
      assert.equal(retried.status, 202);
      assert.equal(state.events[0]?.processingStatus, 'QUEUED');
      assert.equal(state.deployments.length, 1);
      assert.deepEqual(queued, [deploymentId]);
    },
  );
});

test('pending reconciliation recovers after event and deployment persistence windows', async () => {
  for (const deploymentAlreadyExists of [false, true]) {
    const state = repositories();
    const event = await state.repositories.webhookEvents.create({
      deliveryId: `reconcile-${deploymentAlreadyExists}`,
      eventName: 'push',
      payloadSha256: 'a'.repeat(64),
      processingStatus: 'RECEIVED',
      projectId,
      commitSha: sha,
    });
    if (deploymentAlreadyExists) {
      await state.repositories.deployments.createQueued({
        projectId,
        commitSha: sha,
        sourceWebhookEventId: event.id,
      });
    }
    const queued: string[] = [];
    const processor = new GithubWebhookProcessor(state.repositories, {
      secret,
      queue: {
        enqueueDeployment: async (id) => {
          queued.push(id);
        },
      },
    });

    assert.equal(await processor.reconcilePending(), 1);
    assert.equal(state.events[0]?.processingStatus, 'QUEUED');
    assert.equal(state.deployments.length, 1);
    assert.deepEqual(queued, [deploymentId]);
  }
});

test('webhook rejects oversized bodies and duplicate required headers', async () => {
  const state = repositories();
  await withApi(
    state.repositories,
    { enqueueDeployment: async () => undefined },
    async (url) => {
      const oversized = 'x'.repeat(1_048_577);
      const oversizedResponse = await fetch(`${url}/api/webhooks/github`, {
        method: 'POST',
        headers: headers(oversized, 'oversized'),
        body: oversized,
      });
      assert.equal(oversizedResponse.status, 413);

      const body = pushPayload();
      const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      const duplicateStatus = await postWithRawHeaders(
        `${url}/api/webhooks/github`,
        [
          'content-type',
          'application/json',
          'x-github-delivery',
          'duplicate-header',
          'x-github-event',
          'push',
          'x-hub-signature-256',
          signature,
          'x-hub-signature-256',
          signature,
        ],
        body,
      );
      assert.equal(duplicateStatus, 401);
      assert.equal(state.events.length, 0);
    },
  );
});
