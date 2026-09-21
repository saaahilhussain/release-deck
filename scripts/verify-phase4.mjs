import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ConcurrencyError,
  connectMongo,
  initializeDomainRepositories,
} from '../packages/db/dist/index.js';
import {
  CiStepError,
  ProcessCancelledError,
  ProcessTimeoutError,
  createCiRunner,
} from '../packages/ci-runner/dist/index.js';
import {
  createDeploymentQueue,
  createDeploymentWorker,
} from '../packages/queue/dist/index.js';
import { connectRedis, createLogger } from '../packages/runtime/dist/index.js';
import { startWorker } from '../apps/worker/dist/worker.js';

const execFile = promisify(execFileCallback);
const UUID_SUFFIX = /^[0-9a-f]{16,64}$/i;
const MONGO_DATABASE_PATTERN = /^releasedeck_phase4_verify_[0-9a-f]{16,64}$/i;
const REDIS_PREFIX_PATTERN = /^releasedeck-phase4-verify-[0-9a-f]{16,64}$/i;
const STAGES = ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD'];

let stage = 'initialization';
let verificationError;
let cleanupError;
let mongoConnection;
let repositories;
let worker;
let queue;
let redisConnection;
let databaseOwned = false;
let redisNamespaceOwned = false;
let fixtureRoot;
let workspaceRoot;
let sentinelRoot;

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be explicitly supplied`);
  }
  return value;
}

function isolatedNamespace(value, name, pattern) {
  if (!pattern.test(value) || !UUID_SUFFIX.test(value.slice(-16))) {
    throw new Error(`${name} must be a randomized Phase 4 namespace`);
  }
  return value;
}

function scopedMongoUri(value, databaseName) {
  if (
    [...value].some(
      (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error('MONGODB_URI contains a control character');
  }
  const match = /^(mongodb(?:\+srv)?:\/\/[^/?#]+)(?:\/([^?#]*))?(\?.*)?$/i.exec(value);
  if (!match) throw new Error('MONGODB_URI must be a MongoDB URI with one authority');
  const existingDatabase = match[2] ?? '';
  if (existingDatabase && decodeURIComponent(existingDatabase) !== databaseName) {
    throw new Error(
      'MONGODB_URI database must be empty or the supplied isolated database',
    );
  }
  const authority = match[1];
  const hosts = authority.slice(authority.lastIndexOf('@') + 1).split(',');
  if (!hosts.every((host) => host.length > 0)) {
    throw new Error('MONGODB_URI contains an invalid host list');
  }
  return `${authority}/${databaseName}${match[3] ?? ''}`;
}

function validateRedisUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('REDIS_URL is invalid');
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('REDIS_URL must use redis or rediss');
  }
  return value;
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

async function createFixture(directory, { testSource, buildSource }) {
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'releasedeck-phase4-fixture',
        version: '1.0.0',
        private: true,
        scripts: { test: 'node test.mjs', build: 'node build.mjs' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(directory, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'releasedeck-phase4-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: 'releasedeck-phase4-fixture',
            version: '1.0.0',
            private: true,
            scripts: { test: 'node test.mjs', build: 'node build.mjs' },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(directory, 'test.mjs'), `${testSource}\n`);
  await writeFile(join(directory, 'build.mjs'), `${buildSource}\n`);
}

async function createTwoCommitFixture() {
  const directory = await mkdtemp(join(fixtureRoot, 'two-commit-'));
  await createFixture(directory, {
    testSource: "console.log('fixture commit A test');",
    buildSource: "console.log('fixture commit A build');",
  });
  await git(directory, ['init', '--quiet', '--initial-branch=main']);
  await git(directory, [
    'config',
    'user.email',
    'releasedeck-verifier@example.invalid',
  ]);
  await git(directory, ['config', 'user.name', 'ReleaseDeck verifier']);
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '--quiet', '-m', 'fixture commit A']);
  const firstSha = await git(directory, ['rev-parse', 'HEAD']);
  await writeFile(join(directory, 'branch-tip.txt'), 'newer branch tip\n');
  await git(directory, ['add', 'branch-tip.txt']);
  await git(directory, ['commit', '--quiet', '-m', 'fixture commit B']);
  const branchSha = await git(directory, ['rev-parse', 'HEAD']);
  assert.notEqual(firstSha, branchSha);
  return { directory, firstSha, branchSha, url: pathToFileURL(directory).href };
}

async function createFailureFixtures() {
  const failure = await mkdtemp(join(fixtureRoot, 'failure-'));
  await createFixture(failure, {
    testSource: "console.log('x'.repeat(5000)); process.exit(7);",
    buildSource: "console.log('build must not run');",
  });
  const timeout = await mkdtemp(join(fixtureRoot, 'timeout-'));
  await createFixture(timeout, {
    testSource: 'setInterval(() => {}, 60_000);',
    buildSource: "console.log('build must not run');",
  });
  const malformed = await mkdtemp(join(fixtureRoot, 'malformed-'));
  await createFixture(malformed, {
    testSource: "console.log('test must not run');",
    buildSource: "console.log('build must not run');",
  });
  await writeFile(join(malformed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  const commit = async (directory, message) => {
    await git(directory, ['init', '--quiet', '--initial-branch=main']);
    await git(directory, [
      'config',
      'user.email',
      'releasedeck-verifier@example.invalid',
    ]);
    await git(directory, ['config', 'user.name', 'ReleaseDeck verifier']);
    await git(directory, ['add', '.']);
    await git(directory, ['commit', '--quiet', '-m', message]);
    return {
      url: pathToFileURL(directory).href,
      commitSha: await git(directory, ['rev-parse', 'HEAD']),
    };
  };
  return {
    failure: await commit(failure, 'failing fixture'),
    timeout: await commit(timeout, 'timeout fixture'),
    malformed: await commit(malformed, 'malformed fixture'),
  };
}

async function workspaceIsEmpty() {
  return (await readdir(workspaceRoot)).length === 0;
}

async function waitFor(predicate, label, milliseconds = 60_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function queueKeys(client, prefix) {
  let cursor = '0';
  const keys = [];
  do {
    const result = await client.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
    [cursor] = result;
    keys.push(...result[1]);
  } while (cursor !== '0');
  return keys;
}

function runnerFor(root, limits = {}) {
  return createCiRunner({
    workspaceRoot: root,
    limits: {
      checkoutTimeoutMs: 30_000,
      installTimeoutMs: 30_000,
      testTimeoutMs: 30_000,
      buildTimeoutMs: 30_000,
      totalTimeoutMs: 90_000,
      outputLimitBytes: 1_024,
      killGraceMs: 1_000,
      ...limits,
    },
  });
}

async function assertFailureCase(label, runner, input, expectedError, options = {}) {
  let thrown;
  try {
    await runner.run(input, options.hooks);
  } catch (error) {
    thrown = error;
  }
  assert.ok(
    thrown instanceof expectedError,
    `${label} should throw ${expectedError.name}`,
  );
  if (options.stage) assert.equal(thrown.stage, options.stage);
  if (options.result) assert.ok(options.result(thrown));
  assert.equal(await workspaceIsEmpty(), true, `${label} must clean its workspace`);
}

try {
  const mongoBaseUri = requiredEnvironment('MONGODB_URI');
  const redisUrl = validateRedisUrl(requiredEnvironment('REDIS_URL'));
  const databaseName = isolatedNamespace(
    requiredEnvironment('RELEASEDECK_VERIFY_MONGO_DATABASE'),
    'RELEASEDECK_VERIFY_MONGO_DATABASE',
    MONGO_DATABASE_PATTERN,
  );
  const queuePrefix = isolatedNamespace(
    requiredEnvironment('RELEASEDECK_VERIFY_REDIS_PREFIX'),
    'RELEASEDECK_VERIFY_REDIS_PREFIX',
    REDIS_PREFIX_PATTERN,
  );
  const mongoUri = scopedMongoUri(mongoBaseUri, databaseName);

  fixtureRoot = await mkdtemp(join(tmpdir(), 'releasedeck-phase4-fixtures-'));
  workspaceRoot = await mkdtemp(join(tmpdir(), 'releasedeck-phase4-workspaces-'));
  sentinelRoot = await mkdtemp(join(tmpdir(), 'releasedeck-phase4-sentinel-'));
  await writeFile(join(sentinelRoot, 'keep.txt'), 'must survive workspace cleanup\n');

  stage = 'MongoDB isolation check';
  mongoConnection = await connectMongo(mongoUri);
  const existingCollections = await mongoConnection.db.listCollections().toArray();
  if (existingCollections.length !== 0) {
    throw new Error('refusing to use a non-empty verification database');
  }
  databaseOwned = true;
  repositories = await initializeDomainRepositories(mongoConnection.db);

  stage = 'Redis isolation check';
  redisConnection = await connectRedis(redisUrl, {
    commandTimeoutMs: 5_000,
    maxRetriesPerRequest: null,
  });
  if ((await queueKeys(redisConnection.client, queuePrefix)).length !== 0) {
    throw new Error('refusing to use a non-empty verification queue namespace');
  }
  redisNamespaceOwned = true;

  stage = 'fixture creation';
  const source = await createTwoCommitFixture();
  const failureFixtures = await createFailureFixtures();
  const fixtureUrlByCommit = new Map([
    [source.firstSha, source.url],
    [failureFixtures.failure.commitSha, failureFixtures.failure.url],
  ]);
  const project = await repositories.projects.create({
    owner: 'releasedeck-phase4-verify',
    repository: 'local-fixture',
    defaultBranch: 'main',
  });
  const deployment = await repositories.deployments.createQueued({
    projectId: project.id,
    commitSha: source.firstSha,
  });

  stage = 'worker and queue CI flow';
  const environment = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGODB_URI: mongoUri,
    REDIS_URL: redisUrl,
    CI_WORKSPACE_ROOT: workspaceRoot,
    CI_STEP_TIMEOUT_MS: 30_000,
    CI_TOTAL_TIMEOUT_MS: 90_000,
    CI_MAX_OUTPUT_BYTES: 1_024,
    CI_LEASE_MS: 10_000,
    CI_CONCURRENCY: 1,
  };
  const workerRunner = await startWorker(environment, {
    connectMongo,
    initializeDomainRepositories,
    connectRedis,
    createDeploymentWorker: (connection, processor, options) =>
      createDeploymentWorkerWithPrefix(connection, processor, {
        ...options,
        prefix: queuePrefix,
      }),
    createCiRunner: (options) => {
      const runner = createCiRunner(options);
      return {
        run(input, hooks) {
          return runner.run(
            {
              ...input,
              repositoryUrl:
                fixtureUrlByCommit.get(input.commitSha) ?? input.repositoryUrl,
            },
            hooks,
          );
        },
      };
    },
    logger: createLogger('silent'),
  });
  worker = workerRunner;
  queue = createDeploymentQueue(redisConnection.client, { prefix: queuePrefix });
  await queue.waitUntilReady();
  await queue.enqueueDeployment(deployment.id);
  const passed = await waitFor(async () => {
    const current = await repositories.deployments.findById(deployment.id);
    return current?.ci?.status === 'PASSED' ? current : undefined;
  }, 'CI deployment to pass');
  assert.equal(passed.status, 'RUNNING');
  assert.equal(passed.stage, 'BUILD');
  assert.equal(passed.commitSha, source.firstSha);
  assert.deepEqual(
    passed.ci?.stepResults.map((result) => result.stage),
    STAGES,
  );
  assert.ok(passed.ci?.stepResults.every((result) => result.status === 'PASSED'));
  assert.ok(
    passed.ci?.stepResults.every(
      (result) => result.exitCode === 0 && result.signal === null,
    ),
  );
  assert.equal(passed.ci?.cleanup?.status, 'CLEANED');
  assert.ok(passed.ci?.cleanup?.completedAt instanceof Date);
  assert.match(passed.ci?.stepResults[0]?.stdout ?? '', new RegExp(source.firstSha));
  assert.equal(await workspaceIsEmpty(), true);
  await waitFor(
    () =>
      redisConnection.client.zscore(
        `${queuePrefix}:releasedeck-deployments:completed`,
        deployment.id,
      ),
    'retained completed queue job',
  );
  console.log(
    'PASS Phase 4: worker/queue CI flow checked out the requested older SHA and passed CHECKOUT/INSTALL/TEST/BUILD at RUNNING/BUILD',
  );

  stage = 'durable worker failure flow';
  const failedDeployment = await repositories.deployments.createQueued({
    projectId: project.id,
    commitSha: failureFixtures.failure.commitSha,
  });
  await queue.enqueueDeployment(failedDeployment.id);
  const failed = await waitFor(async () => {
    const current = await repositories.deployments.findById(failedDeployment.id);
    return current?.status === 'FAILED' ? current : undefined;
  }, 'CI deployment to record a terminal test failure');
  assert.equal(failed.stage, 'TEST');
  assert.equal(failed.ci?.status, 'FAILED');
  assert.equal(failed.ci?.failure?.kind, 'TEST_FAILED');
  assert.equal(failed.ci?.failure?.retryable, false);
  assert.equal(failed.ci?.cleanup?.status, 'CLEANED');
  assert.equal(failed.ci?.stepResults.at(-1)?.stage, 'TEST');
  assert.equal(failed.ci?.stepResults.at(-1)?.exitCode, 7);
  assert.equal(failed.ci?.stepResults.at(-1)?.signal, null);
  assert.equal(failed.ci?.stepResults.at(-1)?.stdoutTruncated, true);
  assert.equal(
    failed.ci?.stepResults.some((result) => result.stage === 'BUILD'),
    false,
  );
  assert.equal(await workspaceIsEmpty(), true);
  console.log(
    'PASS Phase 4: terminal test failure persisted bounded output, exact stage, cleanup evidence, and skipped BUILD',
  );

  stage = 'concurrent claim and fencing';
  const concurrencyDeployment = await repositories.deployments.createQueued({
    projectId: project.id,
    commitSha: source.firstSha,
  });
  const claimTime = new Date('2026-01-01T00:00:00.000Z');
  const claims = await Promise.all([
    repositories.deployments.claimCiExecution(concurrencyDeployment.id, {
      now: claimTime,
      leaseMs: 10_000,
    }),
    repositories.deployments.claimCiExecution(concurrencyDeployment.id, {
      now: claimTime,
      leaseMs: 10_000,
    }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const firstClaim = claims.find(Boolean);
  assert.ok(firstClaim);
  assert.equal(
    await repositories.deployments.claimCiExecution(concurrencyDeployment.id, {
      now: claimTime,
      leaseMs: 10_000,
    }),
    null,
  );
  const reclaimTime = new Date(claimTime.valueOf() + 10_001);
  const reclaimed = await repositories.deployments.reclaimExpiredCiExecution(
    concurrencyDeployment.id,
    {
      now: reclaimTime,
      leaseMs: 10_000,
    },
  );
  assert.ok(reclaimed);
  assert.equal(reclaimed.fence, firstClaim.fence + 1);
  await assert.rejects(
    repositories.deployments.renewCiExecution(
      concurrencyDeployment.id,
      {
        expectedVersion: firstClaim.deployment.version,
        attemptId: firstClaim.attemptId,
        fence: firstClaim.fence,
        leaseMs: 10_000,
      },
      reclaimTime,
    ),
    ConcurrencyError,
  );
  console.log(
    'PASS Phase 4: concurrent claims have one winner and stale fencing credentials cannot renew a reclaimed attempt',
  );

  stage = 'runner cleanup and bounded failures';
  const directRunner = runnerFor(workspaceRoot);
  const directInput = (fixture) => ({
    deploymentId: randomUUID(),
    repositoryUrl: fixture.url,
    commitSha: fixture.commitSha,
  });
  stage = 'runner cleanup: command failure';
  await assertFailureCase(
    'command failure',
    directRunner,
    directInput(failureFixtures.failure),
    CiStepError,
    {
      stage: 'TEST',
      result: (error) => error.result?.stdoutTruncated === true,
    },
  );
  stage = 'runner cleanup: timeout';
  await assertFailureCase(
    'timeout',
    runnerFor(workspaceRoot, { testTimeoutMs: 1_000, totalTimeoutMs: 10_000 }),
    directInput(failureFixtures.timeout),
    ProcessTimeoutError,
  );
  const cancelled = new AbortController();
  stage = 'runner cleanup: cancellation';
  await assertFailureCase(
    'cancellation',
    runnerFor(workspaceRoot, { testTimeoutMs: 30_000, totalTimeoutMs: 60_000 }),
    { ...directInput(failureFixtures.timeout), signal: cancelled.signal },
    ProcessCancelledError,
    {
      hooks: {
        onStageStarted(currentStage) {
          if (currentStage === 'TEST') setTimeout(() => cancelled.abort(), 100).unref();
        },
      },
    },
  );
  stage = 'runner cleanup: unsupported lockfile policy';
  await assertFailureCase(
    'unsupported lockfile policy',
    directRunner,
    directInput(failureFixtures.malformed),
    CiStepError,
    { stage: 'INSTALL' },
  );
  stage = 'runner cleanup: sentinel preservation';
  assert.equal(
    await readdir(sentinelRoot).then((entries) => entries.includes('keep.txt')),
    true,
  );
  console.log(
    'PASS Phase 4: success, command failure, timeout, cancellation, and policy exception paths clean only allocated workspaces with bounded output',
  );
} catch (error) {
  verificationError = error;
}

try {
  if (queue) await queue.close();
} catch (error) {
  cleanupError ??= error;
}
try {
  if (worker) await worker.close();
} catch (error) {
  cleanupError ??= error;
}
if (redisConnection) {
  try {
    if (redisNamespaceOwned) {
      const keys = await queueKeys(
        redisConnection.client,
        process.env.RELEASEDECK_VERIFY_REDIS_PREFIX,
      );
      if (keys.length > 0) await redisConnection.client.unlink(...keys);
      assert.deepEqual(
        await queueKeys(
          redisConnection.client,
          process.env.RELEASEDECK_VERIFY_REDIS_PREFIX,
        ),
        [],
      );
    }
  } catch (error) {
    cleanupError ??= error;
  } finally {
    try {
      await redisConnection.close();
    } catch (error) {
      cleanupError ??= error;
    }
  }
}
if (mongoConnection) {
  try {
    if (databaseOwned) {
      if (
        mongoConnection.db.databaseName !==
        process.env.RELEASEDECK_VERIFY_MONGO_DATABASE
      ) {
        throw new Error('refusing to drop an unexpected verification database');
      }
      await mongoConnection.db.dropDatabase();
    }
  } catch (error) {
    cleanupError ??= error;
  } finally {
    try {
      await mongoConnection.close();
    } catch (error) {
      cleanupError ??= error;
    }
  }
}
for (const directory of [workspaceRoot, fixtureRoot, sentinelRoot]) {
  if (!directory) continue;
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }
}

if (verificationError) {
  console.error('FAIL Phase 4 verification', {
    stage,
    ...safeFailure(verificationError),
  });
  process.exitCode = 1;
}
if (cleanupError) {
  console.error('FAIL Phase 4 cleanup', safeFailure(cleanupError));
  process.exitCode = 1;
}

function createDeploymentWorkerWithPrefix(connection, processor, options) {
  return createDeploymentWorker(connection, processor, options);
}
