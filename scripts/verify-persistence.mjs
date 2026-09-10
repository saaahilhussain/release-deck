import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  ConcurrencyError,
  DOMAIN_INDEXES,
  DuplicateError,
  connectMongo,
  initializeDomainRepositories,
} from '../packages/db/dist/index.js';

const databaseName = `releasedeck_phase2_verify_${randomUUID().replaceAll('-', '')}`;
const baseUri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/';
let connection;
let verificationDb;
let verificationError;

function sha(character) {
  return character.repeat(40);
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
  connection = await connectMongo(baseUri);
  verificationDb = connection.client.db(databaseName);
  const repositories = await initializeDomainRepositories(verificationDb);

  const project = await repositories.projects.create({
    owner: 'ReleaseDeck-Verify',
    repository: 'Persistence-Probe',
    defaultBranch: 'main',
  });
  assert.equal(project.owner, 'releasedeck-verify');
  assert.equal(project.repository, 'persistence-probe');
  await assert.rejects(
    repositories.projects.create({
      owner: 'RELEASEDECK-VERIFY',
      repository: 'PERSISTENCE-PROBE',
    }),
    DuplicateError,
  );
  console.log('PASS persistence: normalized project uniqueness is enforced');

  const pagingProject = await repositories.projects.create({
    owner: 'releasedeck-verify',
    repository: 'pagination-probe',
  });
  const firstDeployment = await repositories.deployments.createQueued({
    projectId: pagingProject.id,
    commitSha: sha('a'),
  });
  const secondDeployment = await repositories.deployments.createQueued({
    projectId: pagingProject.id,
    commitSha: sha('b'),
  });
  const sharedCreatedAt = new Date('2026-01-01T00:00:00.000Z');
  await verificationDb
    .collection('deployments')
    .updateMany(
      { _id: { $in: [firstDeployment.id, secondDeployment.id] } },
      { $set: { createdAt: sharedCreatedAt, updatedAt: sharedCreatedAt } },
    );
  const firstPage = await repositories.deployments.listByProject(pagingProject.id, {
    limit: 1,
  });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = await repositories.deployments.listByProject(pagingProject.id, {
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0]?.id, firstPage.items[0]?.id);
  console.log('PASS persistence: cursor pages are bounded and non-overlapping');

  const running = await repositories.deployments.transition(firstDeployment.id, {
    expectedVersion: 1,
    status: 'RUNNING',
    stage: 'CHECKOUT',
  });
  assert.equal(running.version, 2);
  await assert.rejects(
    repositories.deployments.transition(firstDeployment.id, {
      expectedVersion: 1,
      stage: 'INSTALL',
    }),
    ConcurrencyError,
  );
  console.log('PASS persistence: deployment updates use optimistic concurrency');

  const concurrentDeployment = await repositories.deployments.createQueued({
    projectId: project.id,
    commitSha: sha('c'),
  });
  const concurrent = await Promise.allSettled([
    repositories.deployments.transition(concurrentDeployment.id, {
      expectedVersion: 1,
      status: 'RUNNING',
      stage: 'CHECKOUT',
    }),
    repositories.deployments.transition(concurrentDeployment.id, {
      expectedVersion: 1,
      status: 'RUNNING',
      stage: 'INSTALL',
    }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    concurrent.filter(
      (result) =>
        result.status === 'rejected' && result.reason instanceof ConcurrencyError,
    ).length,
    1,
  );
  console.log('PASS persistence: concurrent same-version updates have one winner');

  const event = await repositories.webhookEvents.create({
    deliveryId: 'phase2-verification-delivery',
    eventName: 'push',
    metadata: { ref: 'refs/heads/main' },
  });
  assert.equal(
    (await repositories.webhookEvents.findByDeliveryId(event.deliveryId))?.id,
    event.id,
  );
  await assert.rejects(
    repositories.webhookEvents.create({
      deliveryId: event.deliveryId,
      eventName: 'push',
    }),
    DuplicateError,
  );
  console.log('PASS persistence: webhook delivery uniqueness is enforced');

  for (const [collectionName, definitions] of Object.entries(DOMAIN_INDEXES)) {
    const actualNames = new Set(
      (await verificationDb.collection(collectionName).listIndexes().toArray()).map(
        (index) => index.name,
      ),
    );
    for (const definition of definitions) assert.ok(actualNames.has(definition.name));
  }
  console.log('PASS persistence: all required MongoDB indexes exist');
} catch (error) {
  verificationError = error;
}

let cleanupError;
try {
  if (connection) {
    if (!verificationDb || verificationDb.databaseName !== databaseName) {
      throw new Error('refusing to clean an unexpected database');
    }
    await verificationDb.dropDatabase();
  }
} catch (error) {
  cleanupError = error;
} finally {
  if (connection) {
    try {
      await connection.close();
    } catch (error) {
      cleanupError ??= error;
    }
  }
}

if (verificationError) {
  console.error('FAIL persistence verification', safeFailure(verificationError));
  process.exitCode = 1;
}
if (cleanupError) {
  console.error('FAIL persistence cleanup', safeFailure(cleanupError));
  process.exitCode = 1;
}
