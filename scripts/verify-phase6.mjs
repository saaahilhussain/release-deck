import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
  ReleaseDeployerError,
  cleanupPreparedRelease,
  openPreparedRelease,
  prepareRelease,
} from '../packages/release-deployer/dist/index.js';
import { connectRedis, createLogger } from '../packages/runtime/dist/index.js';
import { startWorker } from '../apps/worker/dist/worker.js';
import { processManualRollback } from '../apps/worker/dist/manual-rollback.js';

const execFile = promisify(execFileCallback);
const mongoPattern = /^releasedeck_phase6_verify_[0-9a-f]{16,64}$/i;
const redisPattern = /^releasedeck-phase6-verify-[0-9a-f]{16,64}$/i;
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
  if (match[2] && decodeURIComponent(match[2]) !== database)
    throw new Error('MONGODB_URI names a different database');
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
    {
      windowsHide: true,
      maxBuffer: 1_000_000,
    },
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

  fixtureRoot = await mkdtemp(join(tmpdir(), 'releasedeck-phase6-fixture-'));
  workspaceRoot = await mkdtemp(join(tmpdir(), 'releasedeck-phase6-workspace-'));
  artifactRoot = await mkdtemp(join(tmpdir(), 'releasedeck-phase6-artifact-'));
  await writeFile(
    join(fixtureRoot, 'package.json'),
    `${JSON.stringify({
      name: 'releasedeck-phase6-fixture',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node test.mjs', build: 'node build.mjs' },
    })}\n`,
  );
  await writeFile(
    join(fixtureRoot, 'package-lock.json'),
    `${JSON.stringify({
      name: 'releasedeck-phase6-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'releasedeck-phase6-fixture', version: '1.0.0', private: true },
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
  await git(fixtureRoot, ['commit', '--quiet', '-m', 'healthy release A']);
  const commitA = await git(fixtureRoot, ['rev-parse', 'HEAD']);
  await writeFile(join(fixtureRoot, 'release.txt'), 'candidate B\n');
  await git(fixtureRoot, ['add', '.']);
  await git(fixtureRoot, ['commit', '--quiet', '-m', 'unhealthy release B']);
  const commitB = await git(fixtureRoot, ['rev-parse', 'HEAD']);
  assert.notEqual(commitA, commitB);
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
    owner: 'releasedeck-phase6-verify',
    repository: 'fixture',
    defaultBranch: 'main',
  });
  const deploymentA = await repositories.deployments.createQueued({
    projectId: project.id,
    commitSha: commitA,
  });
  const deploymentB = await repositories.deployments.createQueued({
    projectId: project.id,
    commitSha: commitB,
  });
  const prepared = [];
  const staged = [];
  const promoted = [];
  const remote = { active: undefined, knownGood: undefined };
  const releaseOperations = {
    async prepareRelease(input) {
      prepared.push(input.commitSha);
      return prepareRelease(input);
    },
    openPreparedRelease,
    async stageRelease(input) {
      staged.push(input.commitSha);
      assert.equal(input.artifact.commitSha, input.commitSha);
    },
    async promoteRelease(input) {
      promoted.push(input.commitSha);
      const path = `/srv/apps/${input.projectId}/releases/${input.deploymentId}`;
      if (input.commitSha === commitA) {
        const previous = remote.active;
        remote.active = { deploymentId: input.deploymentId, commitSha: commitA, path };
        remote.knownGood = previous ?? remote.active;
        return {
          status: 'PROMOTED',
          proof: {
            projectId: input.projectId,
            deploymentId: input.deploymentId,
            commitSha: commitA,
            remoteReleasePath: path,
            activeTarget: path,
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
      }
      assert.equal(input.commitSha, commitB);
      assert.equal(
        remote.knownGood?.commitSha,
        commitA,
        'A must be the known-good predecessor before B',
      );
      // Mock target behavior: B fails health, then the existing A release is restored and re-proven healthy.
      remote.active = { deploymentId: input.deploymentId, commitSha: commitB, path };
      remote.active = remote.knownGood;
      return {
        status: 'ROLLED_BACK',
        restored: {
          deploymentId: deploymentA.id,
          releaseId: deploymentA.id,
          commitSha: commitA,
          remoteReleasePath: remote.knownGood.path,
          activeTarget: remote.knownGood.path,
        },
        healthProof: {
          url: input.target.healthUrl,
          statusCode: 200,
          attempts: 2,
          completedAt: new Date(),
        },
      };
    },
    async cleanupPreparedRelease(root, id) {
      await cleanupPreparedRelease(root, id);
    },
  };

  stage = 'worker and queue automatic rollback flow';
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
          run: (input, hooks) => {
            assert.ok(
              input.commitSha === commitA || input.commitSha === commitB,
              'worker must build only the two exact fixture SHAs',
            );
            return runner.run({ ...input, repositoryUrl: fixtureUrl }, hooks);
          },
        };
      },
      releaseOperations,
      logger: createLogger('silent'),
    },
  );
  queue = createDeploymentQueue(redis.client, { prefix });
  await queue.waitUntilReady();
  await queue.enqueueDeployment(deploymentA.id);
  const completedA = await waitFor(async () => {
    const current = await repositories.deployments.findById(deploymentA.id);
    return current?.status === 'SUCCESS' ? current : undefined;
  }, 'A SUCCESS/COMPLETE');
  assert.equal(completedA.commitSha, commitA);
  assert.equal(completedA.stage, 'COMPLETE');
  assert.equal(completedA.release?.status, 'DEPLOYED');
  assert.equal(completedA.release?.health?.statusCode, 200);
  await queue.enqueueDeployment(deploymentB.id);
  const completedB = await waitFor(async () => {
    const current = await repositories.deployments.findById(deploymentB.id);
    return current?.status === 'ROLLED_BACK' ? current : undefined;
  }, 'B ROLLED_BACK/ROLLBACK');
  const stillA = await repositories.deployments.findById(deploymentA.id);
  assert.equal(
    stillA?.status,
    'SUCCESS',
    'A remains a successful historical deployment',
  );
  assert.equal(stillA?.stage, 'COMPLETE');
  assert.equal(completedB.commitSha, commitB);
  assert.equal(completedB.stage, 'ROLLBACK');
  assert.equal(completedB.release?.status, 'ROLLED_BACK');
  assert.equal(completedB.release?.rollback?.mode, 'AUTOMATIC');
  assert.equal(completedB.release?.rollback?.outcome, 'RESTORED');
  assert.equal(completedB.release?.rollback?.target.deploymentId, deploymentA.id);
  assert.equal(completedB.release?.rollback?.target.commitSha, commitA);
  assert.equal(completedB.release?.rollback?.health?.statusCode, 200);
  assert.deepEqual(
    prepared,
    [commitA, commitB],
    'the old A release must not be prepared again',
  );
  assert.deepEqual(
    staged,
    [commitA, commitB],
    'the old A release must not be staged again',
  );
  assert.deepEqual(promoted, [commitA, commitB]);
  assert.equal(remote.active?.commitSha, commitA);
  await waitFor(async () => {
    const [workspaces, artifacts] = await Promise.all([
      readdir(workspaceRoot),
      readdir(artifactRoot),
    ]);
    return workspaces.length === 0 && artifacts.length === 0 ? true : undefined;
  }, 'automatic rollback cleanup');
  assert.deepEqual(await readdir(workspaceRoot), [], 'CI workspaces are removed');
  assert.deepEqual(
    await readdir(artifactRoot),
    [],
    'prepared release artifacts are removed',
  );

  stage = 'manual rollback success and failure against MongoDB';
  const healthyCandidate = await repositories.deployments.createQueued({
    projectId: project.id,
    commitSha: commitA,
  });
  await queue.enqueueDeployment(healthyCandidate.id);
  const completedC = await waitFor(async () => {
    const current = await repositories.deployments.findById(healthyCandidate.id);
    return current?.status === 'SUCCESS' ? current : undefined;
  }, 'healthy candidate C');
  assert.equal(remote.knownGood?.deploymentId, deploymentA.id);
  const manualOptions = {
    leaseMs: 10_000,
    retention: 5,
    target: {
      host: 'target.example.com',
      port: 22,
      user: 'deployer',
      privateKeyPath: join(fixtureRoot, 'key'),
      knownHostsPath: join(fixtureRoot, 'known_hosts'),
      remoteRoot: '/srv/apps',
      timeoutMs: 30_000,
      outputLimitBytes: 4_096,
      healthUrl: 'http://127.0.0.1:3000/health',
      healthAttempts: 5,
      healthIntervalMs: 1_000,
      healthRequestTimeoutMs: 2_000,
    },
  };
  const manualRepositories = { deployments: repositories.deployments };
  const restoredC = await processManualRollback(
    completedC.id,
    deploymentA.id,
    manualRepositories,
    {
      async rollbackRelease(input) {
        assert.equal(input.targetDeploymentId, deploymentA.id);
        assert.equal(remote.knownGood?.deploymentId, deploymentA.id);
        remote.active = remote.knownGood;
        return {
          status: 'RESTORED',
          proof: {
            projectId: project.id,
            deploymentId: deploymentA.id,
            ...completedA.release.success,
          },
          healthProof: {
            url: input.target.healthUrl,
            statusCode: 200,
            attempts: 1,
            completedAt: new Date(),
          },
        };
      },
    },
    manualOptions,
  );
  assert.equal(restoredC.status, 'ROLLED_BACK');
  assert.equal(restoredC.release?.rollback?.mode, 'MANUAL');
  assert.equal(restoredC.release?.rollback?.target.deploymentId, deploymentA.id);
  assert.equal(restoredC.release?.rollback?.health?.statusCode, 200);
  assert.equal(remote.active?.deploymentId, deploymentA.id);

  const failingCandidate = await repositories.deployments.createQueued({
    projectId: project.id,
    commitSha: commitA,
  });
  await queue.enqueueDeployment(failingCandidate.id);
  const completedD = await waitFor(async () => {
    const current = await repositories.deployments.findById(failingCandidate.id);
    return current?.status === 'SUCCESS' ? current : undefined;
  }, 'healthy candidate D');
  const failedD = await processManualRollback(
    completedD.id,
    deploymentA.id,
    manualRepositories,
    {
      async rollbackRelease() {
        assert.equal(remote.knownGood?.deploymentId, deploymentA.id);
        remote.active = undefined;
        return {
          status: 'ROLLBACK_FAILED',
          active: {
            projectId: project.id,
            deploymentId: completedD.id,
            commitSha: commitA,
          },
          attemptedRestore: {
            projectId: project.id,
            deploymentId: deploymentA.id,
            commitSha: commitA,
          },
          failureCode: 'active_restore_failed',
        };
      },
    },
    manualOptions,
  );
  assert.equal(failedD.status, 'FAILED');
  assert.equal(failedD.stage, 'ROLLBACK');
  assert.equal(failedD.release?.status, 'ROLLBACK_FAILED');
  assert.equal(failedD.release?.rollback?.mode, 'MANUAL');
  assert.equal(failedD.release?.rollback?.outcome, 'FAILED');
  assert.equal(failedD.release?.rollback?.health, undefined);
  const rejectedA = await processManualRollback(
    deploymentA.id,
    completedC.id,
    manualRepositories,
    {
      async rollbackRelease() {
        throw new ReleaseDeployerError('remote', 'stale active release', {
          exitCode: 66,
        });
      },
    },
    manualOptions,
  );
  assert.equal(rejectedA.status, 'SUCCESS');
  assert.equal(rejectedA.stage, 'COMPLETE');
  assert.equal(rejectedA.release?.status, 'DEPLOYED');
  assert.equal(rejectedA.release?.manualRollback?.status, 'REJECTED');
  await waitFor(async () => {
    const [workspaces, artifacts] = await Promise.all([
      readdir(workspaceRoot),
      readdir(artifactRoot),
    ]);
    return workspaces.length === 0 && artifacts.length === 0 ? true : undefined;
  }, 'manual rollback fixture cleanup');
  assert.deepEqual(await readdir(workspaceRoot), [], 'CI workspaces are removed');
  assert.deepEqual(
    await readdir(artifactRoot),
    [],
    'prepared release artifacts are removed',
  );
  console.log(
    'PASS Phase 6: isolated worker/queue flow restored healthy A after broken B; manual rollback success and failure persisted without rebuilding predecessors',
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
  if (directory)
    await rm(directory, { recursive: true, force: true }).catch(
      (error) => (cleanupFailure ??= error),
    );
}
if (failure) {
  console.error('FAIL Phase 6 verification', {
    stage,
    name: failure instanceof Error ? failure.name : 'Error',
    ...(failure instanceof assert.AssertionError ? { message: failure.message } : {}),
  });
  process.exitCode = 1;
}
if (cleanupFailure) {
  console.error('FAIL Phase 6 cleanup', {
    name: cleanupFailure instanceof Error ? cleanupFailure.name : 'Error',
  });
  process.exitCode = 1;
}
