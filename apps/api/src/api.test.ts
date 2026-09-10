import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createLogger } from '@releasedeck/runtime';
import { createApp } from './app.js';
import type {
  ApiRepositories,
  CursorPage,
  DeploymentRecord,
  ProjectRecord,
  WebhookEventRecord,
} from './services.js';
import { DeploymentService, WebhookEventService } from './services.js';

const now = new Date('2026-01-01T00:00:00.000Z');
const project: ProjectRecord = {
  id: '01234567-89ab-4cde-8012-3456789abcde',
  provider: 'github',
  owner: 'example',
  repository: 'releasedeck',
  defaultBranch: 'main',
  createdAt: now,
  updatedAt: now,
};
const deployment: DeploymentRecord = {
  id: 'fedcba98-7654-4321-8fed-cba987654321',
  projectId: project.id,
  commitSha: '0123456789abcdef0123456789abcdef01234567',
  provider: 'github',
  status: 'QUEUED',
  stage: 'QUEUED',
  version: 1,
  createdAt: now,
  updatedAt: now,
};

function page<T>(items: T[], nextCursor?: string): CursorPage<T> {
  return { items, nextCursor: nextCursor ?? null };
}

type JsonObject = Record<string, unknown>;

async function object(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

function repositories(overrides: Partial<ApiRepositories> = {}): ApiRepositories {
  return {
    projects: {
      create: async () => project,
      findById: async (id) => (id === project.id ? project : null),
      list: async () => page([project], 'next-page'),
    },
    deployments: {
      createQueued: async () => deployment,
      findById: async (id) => (id === deployment.id ? deployment : null),
      listByProject: async () => page([deployment]),
      transition: async () => deployment,
    },
    webhookEvents: {
      create: async (input) =>
        ({
          id: '11111111-1111-4111-8111-111111111111',
          ...input,
          provider: 'github',
          createdAt: now,
          metadata: input.metadata ?? {},
        }) as WebhookEventRecord,
      findByDeliveryId: async () => null,
    },
    ...overrides,
  };
}

async function withApi(
  repos: ApiRepositories,
  assertion: (url: string) => Promise<void>,
): Promise<void> {
  const server = createApp({
    mongo: { ping: async () => undefined },
    redis: { ping: async () => undefined },
    logger: createLogger('silent'),
    repositories: repos,
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

test('project routes return stable records and cursor pages', async () => {
  await withApi(repositories(), async (url) => {
    const created = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: ' Example ',
        repository: ' ReleaseDeck ',
        defaultBranch: ' main ',
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(((await object(created)).project as JsonObject).owner, project.owner);

    const listed = await fetch(`${url}/api/projects?limit=1`);
    assert.equal(listed.status, 200);
    assert.deepEqual((await object(listed)).nextCursor, 'next-page');

    const detail = await fetch(`${url}/api/projects/${project.id}`);
    assert.equal(detail.status, 200);
    assert.equal(((await object(detail)).project as JsonObject).id, project.id);
  });
});

test('strict validation, malformed JSON, oversized body, and invalid IDs are safe', async () => {
  await withApi(repositories(), async (url) => {
    const strict = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: 'example',
        repository: 'releasedeck',
        unexpected: true,
      }),
    });
    assert.equal(strict.status, 400);
    assert.equal(((await object(strict)).error as JsonObject).code, 'BAD_REQUEST');

    const malformed = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal(
      ((await object(malformed)).error as JsonObject).message,
      'malformed JSON',
    );

    const tooLarge = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'x'.repeat(100_000), repository: 'releasedeck' }),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(
      ((await object(tooLarge)).error as JsonObject).code,
      'PAYLOAD_TOO_LARGE',
    );

    const invalidId = await fetch(`${url}/api/projects/not-a-uuid`);
    assert.equal(invalidId.status, 400);
    assert.equal(((await object(invalidId)).error as JsonObject).code, 'BAD_REQUEST');

    const invalidCursor = await fetch(`${url}/api/projects?cursor=not%20opaque`);
    assert.equal(invalidCursor.status, 400);
  });
});

test('deployment routes distinguish missing resources and hide persistence details', async () => {
  await withApi(repositories(), async (url) => {
    const list = await fetch(`${url}/api/projects/${project.id}/deployments`);
    assert.equal(list.status, 200);
    assert.equal(
      ((await object(list)).deployments as JsonObject[])[0]!.id,
      deployment.id,
    );

    const detail = await fetch(`${url}/api/deployments/${deployment.id}`);
    assert.equal(detail.status, 200);
    assert.equal(((await object(detail)).deployment as JsonObject).status, 'QUEUED');

    const missing = await fetch(
      `${url}/api/deployments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    assert.equal(missing.status, 404);
    assert.equal(((await object(missing)).error as JsonObject).code, 'NOT_FOUND');
  });

  const persistenceError = new Error('mongodb URI and server internals');
  await withApi(
    repositories({
      projects: {
        create: async () => {
          throw persistenceError;
        },
        findById: async () => project,
        list: async () => page([project]),
      },
    }),
    async (url) => {
      const response = await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: 'example', repository: 'releasedeck' }),
      });
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.deepEqual(body, {
        error: { code: 'INTERNAL_ERROR', message: 'internal server error' },
      });
      assert.equal(JSON.stringify(body).includes('mongodb URI'), false);
    },
  );
});

test('duplicate persistence errors map to a conflict envelope', async () => {
  await withApi(
    repositories({
      projects: {
        create: async () => {
          throw { code: 'DUPLICATE' };
        },
        findById: async () => project,
        list: async () => page([project]),
      },
    }),
    async (url) => {
      const response = await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: 'example', repository: 'releasedeck' }),
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await object(response), {
        error: {
          code: 'CONFLICT',
          message: 'project already exists',
        },
      });
    },
  );
});

test('internal services support queued deployments and bounded webhook metadata', async () => {
  let queuedInput: unknown;
  let webhookInput: unknown;
  const repos = repositories({
    deployments: {
      createQueued: async (input) => {
        queuedInput = input;
        return deployment;
      },
      findById: async () => deployment,
      listByProject: async () => page([deployment]),
      transition: async () => deployment,
    },
    webhookEvents: {
      create: async (input) => {
        webhookInput = input;
        return {
          id: '11111111-1111-4111-8111-111111111111',
          ...input,
          provider: 'github',
          createdAt: now,
          metadata: input.metadata ?? {},
        } as WebhookEventRecord;
      },
      findByDeliveryId: async () => null,
    },
  });

  const created = await new DeploymentService(
    repos.deployments,
    repos.projects,
  ).createQueued({
    projectId: project.id,
    commitSha: deployment.commitSha,
  });
  assert.equal(created.status, 'QUEUED');
  assert.deepEqual(queuedInput, {
    projectId: project.id,
    commitSha: deployment.commitSha,
  });

  const event = await new WebhookEventService(repos.webhookEvents).record({
    deliveryId: 'delivery-1',
    eventName: 'push',
    metadata: { ref: 'refs/heads/main' },
  });
  assert.equal(event.provider, 'github');
  assert.deepEqual(webhookInput, {
    deliveryId: 'delivery-1',
    eventName: 'push',
    metadata: { ref: 'refs/heads/main' },
  });
});
