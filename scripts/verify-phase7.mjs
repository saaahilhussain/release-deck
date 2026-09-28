import assert from 'node:assert/strict';
import { once } from 'node:events';

import {
  connectMongo,
  initializeDomainRepositories,
} from '../packages/db/dist/index.js';
import { createLogger } from '../packages/runtime/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';

const uri = process.env.RELEASEDECK_VERIFY_MONGO_URI;
const match =
  /^mongodb:\/\/127\.0\.0\.1:27018\/(releasedeck_phase7_verify_[0-9a-f]{16,64})$/i.exec(
    uri ?? '',
  );
if (!match) {
  throw new Error(
    'RELEASEDECK_VERIFY_MONGO_URI must name a randomized phase7 database on 127.0.0.1:27018',
  );
}

let mongo;
let server;
let ownedDatabase = false;
let eventReader;
let eventAbort;
let failure;

async function json(response) {
  assert.equal(response.status, 200);
  return response.json();
}

async function readDeploymentEvent(reader, state) {
  const deadline = Date.now() + 12_000;
  for (;;) {
    const separator = state.buffer.indexOf('\n\n');
    if (separator >= 0) {
      const frame = state.buffer.slice(0, separator);
      state.buffer = state.buffer.slice(separator + 2);
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (event === 'deployment' && data) return JSON.parse(data);
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('timed out waiting for SSE deployment');
    let timer;
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out waiting for SSE deployment')),
          remaining,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (result.done) throw new Error('SSE ended before deployment update');
    state.buffer += state.decoder.decode(result.value, { stream: true });
    state.buffer = state.buffer.replace(/\r\n/g, '\n');
  }
}

try {
  mongo = await connectMongo(uri);
  const existing = await mongo.db.listCollections({}, { nameOnly: true }).toArray();
  assert.equal(existing.length, 0, 'verification database must be empty');
  ownedDatabase = true;
  const repositories = await initializeDomainRepositories(mongo.db);
  const project = await repositories.projects.create({
    owner: 'phase7-verifier',
    repository: 'release-deck',
    defaultBranch: 'main',
  });
  const deployment = await repositories.deployments.createQueued({
    projectId: project.id,
    commitSha: 'a'.repeat(40),
  });

  server = createApp({
    mongo,
    redis: { ping: async () => undefined },
    logger: createLogger('silent'),
    repositories,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const projects = await json(await fetch(`${base}/api/projects`));
  assert.equal(projects.projects[0]?.id, project.id);
  const deployments = await json(
    await fetch(`${base}/api/projects/${project.id}/deployments`),
  );
  assert.equal(deployments.deployments[0]?.id, deployment.id);
  const detail = await json(await fetch(`${base}/api/deployments/${deployment.id}`));
  assert.equal(detail.deployment.id, deployment.id);
  assert.equal(detail.deployment.status, 'QUEUED');

  eventAbort = new AbortController();
  const stream = await fetch(`${base}/api/deployments/${deployment.id}/events`, {
    signal: eventAbort.signal,
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.ok(stream.body);
  eventReader = stream.body.getReader();
  const state = { buffer: '', decoder: new TextDecoder() };
  const initial = await readDeploymentEvent(eventReader, state);
  assert.equal(initial.deployment.id, deployment.id);
  assert.equal(initial.deployment.version, deployment.version);

  const claimed = await repositories.deployments.claimCiExecution(deployment.id);
  assert.ok(claimed);
  const update = await readDeploymentEvent(eventReader, state);
  assert.equal(update.deployment.version, claimed.deployment.version);
  assert.equal(update.deployment.stage, 'CHECKOUT');
  assert.equal(update.deployment.status, 'RUNNING');
  assert.equal(JSON.stringify(update).includes('leaseExpiresAt'), false);
  assert.equal(JSON.stringify(update).includes('attemptId'), false);
  console.log('Phase 7 real-Mongo API reads and SSE version change passed.');
} catch (error) {
  failure = error;
} finally {
  eventAbort?.abort();
  await eventReader?.cancel().catch(() => undefined);
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ).catch((error) => {
      failure ??= error;
    });
  }
  if (mongo) {
    if (ownedDatabase) {
      await mongo.db.dropDatabase().catch((error) => {
        failure ??= error;
      });
    }
    await mongo.close().catch((error) => {
      failure ??= error;
    });
  }
}

if (failure) throw failure;
