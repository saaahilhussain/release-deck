import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import {
  connectMongo,
  initializeDomainRepositories,
} from '../packages/db/dist/index.js';
import {
  createDeploymentQueue,
  createDeploymentWorker,
} from '../packages/queue/dist/index.js';
import { connectRedis, createLogger } from '../packages/runtime/dist/index.js';
import { startApi } from '../apps/api/dist/server.js';
import { startWorker } from '../apps/worker/dist/worker.js';

const databaseName = `releasedeck_phase3_verify_${randomUUID().replaceAll('-', '')}`;
const baseMongoUri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const webhookSecret = 'releasedeck-phase3-verification-secret';
const deliveryId = randomUUID();
const commitSha = 'a'.repeat(40);
const queueName = 'releasedeck-deployments';
const queuePrefix = `releasedeck-phase3-verify-${randomUUID()}`;

let api;
let worker;
let setupConnection;
let verificationDb;
let verificationError;
let verificationStage = 'initialization';

function databaseUri(uri, name) {
  const match = /^(mongodb(?:\+srv)?:\/\/[^/]+)(?:\/[^?]*)?(\?.*)?$/i.exec(uri);
  if (!match)
    throw new Error('MONGODB_URI cannot be scoped to a verification database');
  return `${match[1]}/${name}${match[2] ?? ''}`;
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitFor(predicate, label, milliseconds = 15_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function queueNamespaceKeys(client) {
  let cursor = '0';
  const keys = [];
  do {
    const result = await client.scan(cursor, 'MATCH', `${queuePrefix}:*`, 'COUNT', 100);
    [cursor] = result;
    keys.push(...result[1]);
  } while (cursor !== '0');
  return keys;
}

function signature(body) {
  return `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
}

function safeFailure(error) {
  const code =
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,31}$/.test(error.code)
      ? error.code
      : undefined;
  return {
    name: error instanceof Error ? error.name : 'Error',
    ...(code ? { code } : {}),
  };
}

try {
  verificationStage = 'database setup';
  const mongoUri = databaseUri(baseMongoUri, databaseName);
  setupConnection = await connectMongo(mongoUri);
  verificationDb = setupConnection.db;
  const setupRepositories = await initializeDomainRepositories(verificationDb);
  const project = await setupRepositories.projects.create({
    owner: 'releasedeck-verify',
    repository: 'webhook-probe',
    defaultBranch: 'main',
  });
  await setupConnection.close();
  setupConnection = undefined;

  const commonEnvironment = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGODB_URI: mongoUri,
    REDIS_URL: redisUrl,
  };
  verificationStage = 'worker startup';
  worker = await startWorker(commonEnvironment, {
    connectMongo,
    initializeDomainRepositories,
    connectRedis,
    createDeploymentWorker: (connection, processor) =>
      createDeploymentWorker(connection, processor, { prefix: queuePrefix }),
    logger: createLogger('silent'),
  });
  const port = await unusedPort();
  verificationStage = 'API startup';
  api = await startApi(
    {
      ...commonEnvironment,
      HOST: '127.0.0.1',
      PORT: port,
      GITHUB_WEBHOOK_SECRET: webhookSecret,
    },
    {
      connectMongo,
      initializeDomainRepositories,
      connectRedis,
      createDeploymentQueue: (connection) =>
        createDeploymentQueue(connection, { prefix: queuePrefix }),
      logger: createLogger('silent'),
    },
  );

  const body = JSON.stringify({
    ref: 'refs/heads/main',
    after: commitSha,
    deleted: false,
    repository: { full_name: 'ReleaseDeck-Verify/Webhook-Probe' },
  });
  const post = () =>
    fetch(`http://127.0.0.1:${port}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': deliveryId,
        'x-github-event': 'push',
        'x-hub-signature-256': signature(body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

  verificationStage = 'concurrent webhook delivery';
  const responses = await Promise.all(Array.from({ length: 8 }, post));
  assert.deepEqual(
    new Set(responses.map((response) => response.status)),
    new Set([202]),
  );

  verificationStage = 'webhook persistence';
  const event = await waitFor(async () => {
    const candidate =
      await api.services.repositories.webhookEvents.findByDeliveryId(deliveryId);
    return candidate?.processingStatus === 'QUEUED' ? candidate : undefined;
  }, 'durable webhook event to become queued');
  assert.equal(event.projectId, project.id);
  assert.equal(event.commitSha, commitSha);
  assert.ok(event.deploymentId);

  verificationStage = 'worker claim';
  const deployment = await waitFor(async () => {
    const candidate = await api.services.repositories.deployments.findById(
      event.deploymentId,
    );
    return candidate?.status === 'RUNNING' && candidate.stage === 'CHECKOUT'
      ? candidate
      : undefined;
  }, 'worker to claim deployment');
  assert.equal(deployment.sourceWebhookEventId, event.id);

  assert.equal(
    await api.services.mongo.db.collection('webhookEvents').countDocuments({
      deliveryId,
    }),
    1,
  );
  assert.equal(
    await api.services.mongo.db.collection('deployments').countDocuments({
      sourceWebhookEventId: event.id,
    }),
    1,
  );

  verificationStage = 'queue inspection';
  const job = await waitFor(async () => {
    const stored = await api.services.redis.client.hgetall(
      `${queuePrefix}:${queueName}:${deployment.id}`,
    );
    return stored.data ? stored : undefined;
  }, 'retained BullMQ job');
  verificationStage = 'queue job name';
  assert.equal(job.name, 'deployment');
  verificationStage = 'queue job payload';
  assert.deepEqual(JSON.parse(job.data), { deploymentId: deployment.id });
  verificationStage = 'queue completed state';
  await waitFor(
    () =>
      api.services.redis.client.zscore(
        `${queuePrefix}:${queueName}:completed`,
        deployment.id,
      ),
    'BullMQ job completion',
  );

  verificationStage = 'redelivery';
  const repeated = await post();
  assert.equal(repeated.status, 202);
  assert.equal(
    await api.services.mongo.db.collection('deployments').countDocuments({
      sourceWebhookEventId: event.id,
    }),
    1,
  );
  console.log(
    'PASS Phase 3: eight concurrent signed deliveries converged to one event, deployment, retained UUID-only queue job, and worker claim',
  );

  verificationStage = 'delivery conflict';
  const conflictingBody = body.replace(commitSha, 'b'.repeat(40));
  const conflict = await fetch(`http://127.0.0.1:${port}/api/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': deliveryId,
      'x-github-event': 'push',
      'x-hub-signature-256': signature(conflictingBody),
    },
    body: conflictingBody,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(conflict.status, 409);
  console.log('PASS Phase 3: conflicting reuse of a delivery ID is rejected');
} catch (error) {
  verificationError = error;
}

let cleanupError;
for (const runtime of [api, worker]) {
  if (!runtime) continue;
  try {
    await runtime.close();
  } catch (error) {
    cleanupError ??= error;
  }
}
try {
  const cleanupRedis = await connectRedis(redisUrl);
  try {
    const keys = await queueNamespaceKeys(cleanupRedis.client);
    if (keys.length > 0) await cleanupRedis.client.unlink(...keys);
    assert.deepEqual(await queueNamespaceKeys(cleanupRedis.client), []);
    console.log('PASS Phase 3 cleanup: removed the isolated BullMQ namespace');
  } finally {
    await cleanupRedis.close();
  }
} catch (error) {
  cleanupError ??= error;
}
try {
  if (setupConnection) await setupConnection.close();
  const cleanupConnection = await connectMongo(baseMongoUri);
  try {
    const cleanupDb = cleanupConnection.client.db(databaseName);
    if (cleanupDb.databaseName !== databaseName) {
      throw new Error('refusing to clean an unexpected database');
    }
    await cleanupDb.dropDatabase();
  } finally {
    await cleanupConnection.close();
  }
} catch (error) {
  cleanupError ??= error;
}

if (verificationError) {
  console.error('FAIL Phase 3 verification', {
    stage: verificationStage,
    ...safeFailure(verificationError),
  });
  process.exitCode = 1;
}
if (cleanupError) {
  console.error('FAIL Phase 3 cleanup', safeFailure(cleanupError));
  process.exitCode = 1;
}
