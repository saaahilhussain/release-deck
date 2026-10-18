import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  connectMongo,
  initializeDomainRepositories,
} from '../packages/db/dist/index.js';
import { createCiRunner } from '../packages/ci-runner/dist/index.js';
import {
  createDeploymentQueue,
  createDeploymentWorker,
} from '../packages/queue/dist/index.js';
import {
  cleanupPreparedRelease,
  openPreparedRelease,
  prepareRelease,
} from '../packages/release-deployer/dist/index.js';
import { connectRedis, createLogger } from '../packages/runtime/dist/index.js';
import { startWorker } from '../apps/worker/dist/worker.js';

const execFile = promisify(execFileCallback);
const mongoPattern = /^releasedeck_phase5_verify_[0-9a-f]{16,64}$/i;
const redisPattern = /^releasedeck-phase5-verify-[0-9a-f]{16,64}$/i;
let mongo;
let redis;
let worker;
let queue;
let fixtureRoot;
let workspaceRoot;
let artifactRoot;
let databaseOwned = false;
let redisOwned = false;
let failure;
let cleanupFailure;
let stage = 'initialization';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be explicitly supplied`);
  return value;
}

function isolated(value, name, pattern) {
  if (!pattern.test(value)) throw new Error(`${name} must be a randomized namespace`);
  return value;
}

function mongoUri(base, database) {
  const match = /^(mongodb(?:\+srv)?:\/\/[^/?#]+)(?:\/([^?#]*))?(\?.*)?$/i.exec(base);
  if (!match) throw new Error('MONGODB_URI is invalid');
  if (match[2] && decodeURIComponent(match[2]) !== database) {
    throw new Error('MONGODB_URI names a different database');
  }
  return `${match[1]}/${database}${match[3] ?? ''}`;
}

async function keys(client, prefix) {
  let cursor = '0';
  const found = [];
  do {
    const result = await client.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
    [cursor] = result;
    found.push(...result[1]);
  } while (cursor !== '0');
  return found;
}

async function git(directory, args) {
  const result = await execFile(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', '-C', directory, ...args],
    { windowsHide: true, maxBuffer: 1_000_000 },
  );
  return result.stdout.trim();
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

try {
  const database = isolated(
    required('RELEASEDECK_VERIFY_MONGO_DATABASE'),
    'RELEASEDECK_VERIFY_MONGO_DATABASE',
    mongoPattern,
  );
  const prefix = isolated(
    required('RELEASEDECK_VERIFY_REDIS_PREFIX'),
    'RELEASEDECK_VERIFY_REDIS_PREFIX',
    redisPattern,
  );
  const scopedMongoUri = mongoUri(required('MONGODB_URI'), database);
  const redisUrl = required('REDIS_URL');
  if (!/^rediss?:\/\//.test(redisUrl)) throw new Error('REDIS_URL is invalid');

  fixtureRoot = await mkdtemp(join(tmpdir(), 'releasedeck-phase5-fixture-'));
  workspaceRoot = await mkdtemp(join(tmpdir(), 'releasedeck-phase5-workspace-'));
  artifactRoot = await mkdtemp(join(tmpdir(), 'releasedeck-phase5-artifact-'));
  await writeFile(
    join(fixtureRoot, 'package.json'),
    `${JSON.stringify({
      name: 'releasedeck-phase5-fixture',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node test.mjs', build: 'node build.mjs' },
    })}\n`,
  );
  await writeFile(
    join(fixtureRoot, 'package-lock.json'),
    `${JSON.stringify({
      name: 'releasedeck-phase5-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'releasedeck-phase5-fixture',
          version: '1.0.0',
          private: true,
        },
      },
    })}\n`,
  );
  await writeFile(join(fixtureRoot, 'test.mjs'), "console.log('test passed');\n");
  await writeFile(join(fixtureRoot, 'build.mjs'), "console.log('build passed');\n");
  await writeFile(
    join(fixtureRoot, 'ecosystem.config.cjs'),
    'module.exports = { apps: [] };\n',
  );
  await git(fixtureRoot, ['init', '--quiet', '--initial-branch=main']);
  await git(fixtureRoot, ['config', 'user.email', 'verify@example.invalid']);
  await git(fixtureRoot, ['config', 'user.name', 'ReleaseDeck verifier']);
  await git(fixtureRoot, ['add', '.']);
  await git(fixtureRoot, ['commit', '--quiet', '-m', 'phase5 fixture']);
  const commitSha = await git(fixtureRoot, ['rev-parse', 'HEAD']);
  const fixtureUrl = pathToFileURL(fixtureRoot).href;

  stage = 'isolated services';
  mongo = await connectMongo(scopedMongoUri);
  assert.equal((await mongo.db.listCollections().toArray()).length, 0);
  databaseOwned = true;
  const repositories = await initializeDomainRepositories(mongo.db);
  redis = await connectRedis(redisUrl, {
    commandTimeoutMs: 5_000,
    maxRetriesPerRequest: null,
  });
  assert.deepEqual(await keys(redis.client, prefix), []);
  redisOwned = true;

  const project = await repositories.projects.create({
    owner: 'releasedeck-phase5-verify',
    repository: 'fixture',
    defaultBranch: 'main',
  });
  const deployment = await repositories.deployments.createQueued({
    projectId: project.id,
    commitSha,
  });
  const calls = [];
  const releaseOperations = {
    prepareRelease,
    openPreparedRelease,
    async stageRelease(input) {
      calls.push('stage');
      await access(input.artifact.archivePath);
      assert.equal(input.artifact.commitSha, commitSha);
    },
    async promoteRelease(input) {
      calls.push('activate');
      const releasePath = `/srv/apps/${input.projectId}/releases/${input.deploymentId}`;
      return {
        status: 'PROMOTED',
        proof: {
          projectId: input.projectId,
          deploymentId: input.deploymentId,
          commitSha: input.commitSha,
          remoteReleasePath: releasePath,
          activeTarget: releasePath,
          pm2ProcessName: `releasedeck-${input.projectId}`,
          pm2Pid: 4321,
          nginx: { validated: true, reloaded: true },
          completedAt: new Date(),
        },
        healthProof: {
          url: input.target.healthUrl,
          statusCode: 200,
          attempts: 1,
          completedAt: new Date(),
        },
      };
    },
    async cleanupPreparedRelease(root, id) {
      calls.push('cleanup');
      await cleanupPreparedRelease(root, id);
    },
  };

  stage = 'worker and queue release flow';
  worker = await startWorker(
    {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      MONGODB_URI: scopedMongoUri,
      REDIS_URL: redisUrl,
      CI_WORKSPACE_ROOT: workspaceRoot,
      CI_STEP_TIMEOUT_MS: 30_000,
      CI_TOTAL_TIMEOUT_MS: 90_000,
      CI_MAX_OUTPUT_BYTES: 4_096,
      CI_LEASE_MS: 10_000,
      CI_CONCURRENCY: 1,
      RELEASE_SSH_HOST: 'target.example.com',
      RELEASE_HEALTH_URL: 'http://127.0.0.1:3000/health',
      RELEASE_HEALTH_ATTEMPTS: 5,
      RELEASE_HEALTH_INTERVAL_MS: 1000,
      RELEASE_HEALTH_REQUEST_TIMEOUT_MS: 2000,
      RELEASE_SSH_PORT: 22,
      RELEASE_SSH_USER: 'deployer',
      RELEASE_SSH_PRIVATE_KEY_PATH: join(fixtureRoot, 'key'),
      RELEASE_SSH_KNOWN_HOSTS_PATH: join(fixtureRoot, 'known_hosts'),
      RELEASE_REMOTE_ROOT: '/srv/apps',
      RELEASE_ARTIFACT_ROOT: artifactRoot,
      RELEASE_TIMEOUT_MS: 30_000,
      RELEASE_MAX_OUTPUT_BYTES: 4_096,
      RELEASE_LEASE_MS: 10_000,
      RELEASE_RETENTION: 5,
    },
    {
      connectMongo,
      initializeDomainRepositories,
      connectRedis,
      createDeploymentWorker: (connection, processor, options) =>
        createDeploymentWorker(connection, processor, { ...options, prefix }),
      createCiRunner: (options) => {
        const runner = createCiRunner(options);
        return {
          run: (input, hooks) =>
            runner.run({ ...input, repositoryUrl: fixtureUrl }, hooks),
        };
      },
      releaseOperations,
      logger: createLogger('silent'),
    },
  );
  queue = createDeploymentQueue(redis.client, { prefix });
  await queue.waitUntilReady();
  await queue.enqueueDeployment(deployment.id);
  const completed = await waitFor(async () => {
    const current = await repositories.deployments.findById(deployment.id);
    return current?.status === 'SUCCESS' ? current : undefined;
  }, 'SUCCESS/COMPLETE deployment');
  assert.equal(completed.stage, 'COMPLETE');
  assert.equal(completed.ci?.status, 'PASSED');
  assert.equal(completed.ci?.cleanup?.status, 'CLEANED');
  assert.equal(completed.release?.status, 'DEPLOYED');
  assert.equal(completed.release?.success?.releaseId, deployment.id);
  assert.equal(completed.release?.success?.commitSha, commitSha);
  // Success is persisted before artifact cleanup; wait for the isolated job to settle.
  await worker.close();
  assert.deepEqual(calls, ['stage', 'activate', 'cleanup']);
  assert.deepEqual(await readdir(workspaceRoot), []);
  assert.deepEqual(await readdir(artifactRoot), []);
  console.log(
    'PASS Phase 5: isolated worker/queue flow persisted CI evidence and fenced release proof at SUCCESS/COMPLETE',
  );
} catch (error) {
  failure = error;
}

for (const close of [async () => queue?.close(), async () => worker?.close()]) {
  try {
    await close();
  } catch (error) {
    cleanupFailure ??= error;
  }
}
if (redis) {
  try {
    if (redisOwned) {
      const prefix = process.env.RELEASEDECK_VERIFY_REDIS_PREFIX;
      const found = await keys(redis.client, prefix);
      if (found.length) await redis.client.unlink(...found);
    }
  } catch (error) {
    cleanupFailure ??= error;
  } finally {
    await redis.close().catch((error) => (cleanupFailure ??= error));
  }
}
if (mongo) {
  try {
    if (databaseOwned) await mongo.db.dropDatabase();
  } catch (error) {
    cleanupFailure ??= error;
  } finally {
    await mongo.close().catch((error) => (cleanupFailure ??= error));
  }
}
for (const directory of [artifactRoot, workspaceRoot, fixtureRoot]) {
  if (directory) {
    await rm(directory, { recursive: true, force: true }).catch(
      (error) => (cleanupFailure ??= error),
    );
  }
}
if (failure) {
  console.error('FAIL Phase 5 verification', {
    stage,
    name: failure instanceof Error ? failure.name : 'Error',
  });
  process.exitCode = 1;
}
if (cleanupFailure) {
  console.error('FAIL Phase 5 cleanup', {
    name: cleanupFailure instanceof Error ? cleanupFailure.name : 'Error',
  });
  process.exitCode = 1;
}
