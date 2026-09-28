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
import type { DeploymentEventOptions } from './routes.js';

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
      findByCoordinates: async (owner, repository) =>
        owner === project.owner && repository === project.repository ? project : null,
      list: async () => page([project], 'next-page'),
    },
    deployments: {
      createQueued: async () => deployment,
      findById: async (id) => (id === deployment.id ? deployment : null),
      findBySourceWebhookEventId: async () => null,
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
      transition: async () => {
        throw new Error('not used');
      },
      listPending: async () => [],
    },
    ...overrides,
  };
}

async function withApi(
  repos: ApiRepositories,
  assertion: (url: string) => Promise<void>,
  deploymentEventOptions?: DeploymentEventOptions,
): Promise<void> {
  const server = createApp({
    mongo: { ping: async () => undefined },
    redis: { ping: async () => undefined },
    logger: createLogger('silent'),
    repositories: repos,
    ...(deploymentEventOptions === undefined ? {} : { deploymentEventOptions }),
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
        findByCoordinates: async () => project,
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
        findByCoordinates: async () => project,
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
      findBySourceWebhookEventId: async () => null,
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
      transition: async () => {
        throw new Error('not used');
      },
      listPending: async () => [],
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

test('deployment detail projects persisted evidence without browser-sensitive fields', async () => {
  const finishedAt = new Date('2026-01-01T00:00:10.000Z');
  let detailed: DeploymentRecord = {
    ...deployment,
    status: 'ROLLED_BACK',
    stage: 'ROLLBACK',
    version: 9,
    ci: {
      status: 'PASSED',
      attemptNumber: 1,
      fence: 7,
      attemptId: 'secret-attempt-id',
      leaseExpiresAt: finishedAt,
      startedAt: now,
      finishedAt,
      stepResults: [
        {
          stage: 'BUILD',
          status: 'PASSED',
          attemptId: 'secret-step-attempt',
          fence: 7,
          startedAt: now,
          finishedAt,
          durationMs: 10_000,
          exitCode: 0,
          signal: null,
          stdout: 'secret-stdout',
          stderr: 'secret-stderr',
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ],
    },
    release: {
      status: 'ROLLED_BACK',
      releaseId: deployment.id,
      attemptNumber: 1,
      fence: 8,
      attemptId: 'secret-release-attempt',
      leaseExpiresAt: finishedAt,
      startedAt: now,
      finishedAt,
      failure: {
        kind: 'REMOTE_FAILED',
        message: 'secret-release-failure',
        retryable: false,
      },
      rollback: {
        mode: 'AUTOMATIC',
        outcome: 'RESTORED',
        requestId: 'secret-rollback-request',
        target: {
          deploymentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          releaseId: 'release-a',
          commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          remoteReleasePath: '/secret/remote/target',
          activeTarget: '/secret/active/target',
        },
        health: {
          url: 'http://127.0.0.1:3000/secret-health-path',
          statusCode: 200,
          attempts: 2,
          completedAt: finishedAt,
        },
        completedAt: finishedAt,
      },
      manualRollback: {
        requestId: 'secret-manual-request',
        targetDeploymentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'RESTORED',
        attemptId: 'secret-manual-attempt',
        attemptNumber: 1,
        fence: 9,
        startedAt: now,
        finishedAt,
      },
    },
  };
  const repos = repositories({
    deployments: {
      ...repositories().deployments,
      findById: async () => detailed,
      listByProject: async () => page([detailed]),
    },
  });

  await withApi(repos, async (url) => {
    const list = await object(
      await fetch(`${url}/api/projects/${project.id}/deployments`),
    );
    const listed = (list.deployments as JsonObject[])[0]!;
    assert.deepEqual(Object.keys(listed), [
      'id',
      'projectId',
      'provider',
      'commitSha',
      'status',
      'stage',
      'version',
      'createdAt',
      'updatedAt',
    ]);

    const response = await fetch(`${url}/api/deployments/${deployment.id}`);
    assert.equal(response.status, 200);
    const detail = (await object(response)).deployment as JsonObject;
    const ci = detail.ci as JsonObject;
    const release = detail.release as JsonObject;
    assert.equal(ci.status, 'PASSED');
    assert.deepEqual((ci.steps as JsonObject[])[0], {
      stage: 'BUILD',
      status: 'PASSED',
      startedAt: now.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: 10_000,
      exitCode: 0,
    });
    assert.equal(release.failureKind, 'REMOTE_FAILED');
    assert.equal((release.rollback as JsonObject).outcome, 'RESTORED');
    assert.equal((release.manualRollback as JsonObject).status, 'RESTORED');
    assert.ok((detail.activity as JsonObject[]).length > 0);
    const serialized = JSON.stringify(detail);
    for (const secret of [
      'secret-stdout',
      'secret-stderr',
      'secret-attempt',
      'secret-release-failure',
      '/secret/',
      'secret-health-path',
      'secret-rollback-request',
      'secret-manual-request',
      'leaseExpiresAt',
      'fence',
    ]) {
      assert.ok(!serialized.includes(secret), `leaked ${secret}`);
    }

    detailed = {
      ...deployment,
      status: 'SUCCESS',
      stage: 'COMPLETE',
      release: {
        status: 'DEPLOYED',
        releaseId: deployment.id,
        attemptNumber: 1,
        fence: 1,
        success: {
          releaseId: deployment.id,
          commitSha: deployment.commitSha,
          remoteReleasePath: '/secret/release',
          activeTarget: '/secret/current',
          pm2ProcessName: 'secret-process',
          pm2Pid: 123,
          nginx: { validated: true, reloaded: true },
          completedAt: finishedAt,
        },
        health: {
          url: 'http://127.0.0.1:3000/secret-health',
          statusCode: 200,
          attempts: 1,
          completedAt: finishedAt,
        },
      },
    };
    const promoted = (
      await object(await fetch(`${url}/api/deployments/${deployment.id}`))
    ).deployment as JsonObject;
    const promotedRelease = promoted.release as JsonObject;
    assert.equal(
      (promotedRelease.success as JsonObject).commitSha,
      deployment.commitSha,
    );
    assert.equal((promotedRelease.health as JsonObject).statusCode, 200);
    assert.ok(!JSON.stringify(promoted).includes('secret-'));
  });
});

test('deployment event stream sends safe snapshots, version changes, heartbeats, and safe errors', async () => {
  let current: DeploymentRecord = deployment;
  let reads = 0;
  let failRead = false;
  const repos = repositories({
    deployments: {
      ...repositories().deployments,
      findById: async (id) => {
        reads += 1;
        if (failRead) throw new Error('secret database address');
        return id === deployment.id ? current : null;
      },
    },
  });

  await withApi(
    repos,
    async (url) => {
      const missing = await fetch(
        `${url}/api/deployments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/events`,
      );
      assert.equal(missing.status, 404);
      assert.equal(((await object(missing)).error as JsonObject).code, 'NOT_FOUND');

      const invalid = await fetch(`${url}/api/deployments/not-a-uuid/events`);
      assert.equal(invalid.status, 400);
      assert.equal(((await object(invalid)).error as JsonObject).code, 'BAD_REQUEST');

      const controller = new AbortController();
      const response = await fetch(`${url}/api/deployments/${deployment.id}/events`, {
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      async function nextFrame(): Promise<string> {
        for (;;) {
          const separator = buffer.indexOf('\n\n');
          if (separator >= 0) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            return frame;
          }
          const result = await reader.read();
          if (result.done) throw new Error('stream ended before expected frame');
          buffer += decoder.decode(result.value, { stream: true });
        }
      }
      try {
        const initial = await nextFrame();
        assert.match(initial, /id: 1\nevent: deployment/);
        assert.match(initial, /"status":"QUEUED"/);

        // Same-version polls do not emit duplicate snapshots.
        const heartbeat = await nextFrame();
        assert.equal(heartbeat, ': heartbeat');
        assert.ok(reads > 1);

        current = { ...deployment, version: 2, status: 'SUCCESS', stage: 'COMPLETE' };
        let changed = await nextFrame();
        while (changed.startsWith(':')) changed = await nextFrame();
        assert.match(changed, /id: 2\nevent: deployment/);
        assert.match(changed, /"stage":"COMPLETE"/);

        // Terminal deployments can still gain a later manual rollback outcome.
        current = { ...current, version: 3, updatedAt: new Date(now.valueOf() + 1) };
        let later = await nextFrame();
        while (later.startsWith(':')) later = await nextFrame();
        assert.match(later, /id: 3\nevent: deployment/);

        failRead = true;
        let error = await nextFrame();
        while (error.startsWith(':')) error = await nextFrame();
        assert.match(error, /event: stream-error/);
        assert.ok(!error.includes('secret database address'));
      } finally {
        controller.abort();
        await reader.cancel().catch(() => undefined);
      }
    },
    { pollIntervalMs: 15, heartbeatIntervalMs: 45 },
  );
});

test('deployment event stream stops polling after the browser disconnects', async () => {
  let reads = 0;
  const repos = repositories({
    deployments: {
      ...repositories().deployments,
      findById: async () => {
        reads += 1;
        return deployment;
      },
    },
  });
  await withApi(
    repos,
    async (url) => {
      const controller = new AbortController();
      const response = await fetch(`${url}/api/deployments/${deployment.id}/events`, {
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /event: deployment/);
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = reads;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(reads, settled);
    },
    { pollIntervalMs: 10, heartbeatIntervalMs: 20 },
  );
});

test('deployment event stream ends at its bounded lifetime for reconnection', async () => {
  await withApi(
    repositories(),
    async (url) => {
      const response = await fetch(`${url}/api/deployments/${deployment.id}/events`);
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /event: deployment/);
      const finished = await reader.read();
      assert.equal(finished.done, true);
    },
    { pollIntervalMs: 100, heartbeatIntervalMs: 100, maxConnectionMs: 30 },
  );
});

test('deployment event admission returns 503 at capacity and recovers after disconnect', async () => {
  await withApi(
    repositories(),
    async (url) => {
      const endpoint = `${url}/api/deployments/${deployment.id}/events`;
      const firstController = new AbortController();
      const secondController = new AbortController();
      let recovered: Response | undefined;
      try {
        const first = await fetch(endpoint, { signal: firstController.signal });
        const second = await fetch(endpoint, { signal: secondController.signal });
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);

        const saturated = await fetch(endpoint);
        assert.equal(saturated.status, 503);
        assert.match(saturated.headers.get('content-type') ?? '', /application\/json/);
        assert.deepEqual(await object(saturated), {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'deployment streams are at capacity',
          },
        });

        firstController.abort();
        await first.body?.cancel().catch(() => undefined);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          recovered = await fetch(endpoint);
          if (recovered.status === 200) break;
          assert.equal(recovered.status, 503);
          await recovered.body?.cancel();
          recovered = undefined;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(recovered?.status, 200);
      } finally {
        firstController.abort();
        secondController.abort();
        await recovered?.body?.cancel().catch(() => undefined);
      }
    },
    { maxActiveStreams: 2 },
  );
});
