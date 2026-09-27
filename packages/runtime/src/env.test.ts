import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';

import {
  ConfigurationError,
  parseApiEnvironment,
  parseWorkerEnvironment,
} from './env.js';
import { DependencyError, errorForLog } from './logger.js';

const validEnvironment = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  MONGODB_URI: 'mongodb://user:secret@127.0.0.1:27017/releasedeck',
  REDIS_URL: 'redis://default:secret@127.0.0.1:6379',
  GITHUB_WEBHOOK_SECRET: 'phase3-test-webhook-secret',
};

const validWorkerEnvironment = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  MONGODB_URI: 'mongodb://user:secret@127.0.0.1:27017/releasedeck',
  REDIS_URL: 'redis://default:secret@127.0.0.1:6379',
  RELEASE_SSH_HOST: 'target.example.com',
  RELEASE_SSH_USER: 'deployer',
  RELEASE_HEALTH_URL: 'http://127.0.0.1:3000/health',
  RELEASE_SSH_PRIVATE_KEY_PATH: resolve('keys', 'release-ed25519'),
  RELEASE_SSH_KNOWN_HOSTS_PATH: resolve('keys', 'known_hosts'),
};

test('parses API defaults', () => {
  const environment = parseApiEnvironment(validEnvironment);
  assert.equal(environment.HOST, '127.0.0.1');
  assert.equal(environment.PORT, 3_000);
});

test('parses worker defaults with an absolute OS-temp workspace root', () => {
  const environment = parseWorkerEnvironment(validWorkerEnvironment);
  assert.ok(environment.CI_WORKSPACE_ROOT.length > 0);
  assert.equal(environment.CI_WORKSPACE_ROOT, resolve(environment.CI_WORKSPACE_ROOT));
  assert.equal(environment.CI_STEP_TIMEOUT_MS, 300_000);
  assert.equal(environment.CI_TOTAL_TIMEOUT_MS, 1_800_000);
  assert.equal(environment.CI_MAX_OUTPUT_BYTES, 1_048_576);
  assert.equal(environment.CI_LEASE_MS, 60_000);
  assert.equal(environment.CI_CONCURRENCY, 1);
  assert.equal(environment.RELEASE_SSH_PORT, 22);
  assert.equal(environment.RELEASE_SSH_USER, 'deployer');
  assert.equal(environment.RELEASE_REMOTE_ROOT, '/srv/apps');
  assert.equal(
    environment.RELEASE_ARTIFACT_ROOT,
    resolve(environment.RELEASE_ARTIFACT_ROOT),
  );
  assert.equal(environment.RELEASE_TIMEOUT_MS, 600_000);
  assert.equal(environment.RELEASE_MAX_OUTPUT_BYTES, 65_536);
  assert.equal(environment.RELEASE_LEASE_MS, 60_000);
  assert.equal(environment.RELEASE_RETENTION, 5);
  assert.equal(environment.RELEASE_HEALTH_URL, 'http://127.0.0.1:3000/health');
  assert.equal(environment.RELEASE_HEALTH_ATTEMPTS, 5);
  assert.ok(environment.CI_TOTAL_TIMEOUT_MS >= environment.CI_STEP_TIMEOUT_MS);
});

test('accepts bounded worker settings and an absolute workspace root', () => {
  const environment = parseWorkerEnvironment({
    ...validWorkerEnvironment,
    CI_WORKSPACE_ROOT: resolve('phase4-workspaces'),
    CI_STEP_TIMEOUT_MS: '1000',
    CI_TOTAL_TIMEOUT_MS: '61000',
    CI_MAX_OUTPUT_BYTES: '1024',
    CI_LEASE_MS: '10000',
    CI_CONCURRENCY: '8',
    RELEASE_SSH_HOST: '192.0.2.10',
    RELEASE_SSH_PORT: '2222',
    RELEASE_SSH_USER: 'release_bot',
    RELEASE_REMOTE_ROOT: '/opt/releasedeck',
    RELEASE_TIMEOUT_MS: '1000',
    RELEASE_HEALTH_ATTEMPTS: '1',
    RELEASE_HEALTH_REQUEST_TIMEOUT_MS: '100',
    RELEASE_MAX_OUTPUT_BYTES: '1024',
    RELEASE_LEASE_MS: '10000',
    RELEASE_RETENTION: '20',
  });
  assert.equal(environment.CI_STEP_TIMEOUT_MS, 1_000);
  assert.equal(environment.CI_TOTAL_TIMEOUT_MS, 61_000);
  assert.equal(environment.CI_MAX_OUTPUT_BYTES, 1_024);
  assert.equal(environment.CI_LEASE_MS, 10_000);
  assert.equal(environment.CI_CONCURRENCY, 8);
  assert.equal(environment.RELEASE_SSH_PORT, 2_222);
  assert.equal(environment.RELEASE_SSH_USER, 'release_bot');
  assert.equal(environment.RELEASE_REMOTE_ROOT, '/opt/releasedeck');
  assert.equal(environment.RELEASE_TIMEOUT_MS, 1_000);
  assert.equal(environment.RELEASE_MAX_OUTPUT_BYTES, 1_024);
  assert.equal(environment.RELEASE_LEASE_MS, 10_000);
  assert.equal(environment.RELEASE_RETENTION, 20);
});

for (const [field, value] of [
  ['CI_WORKSPACE_ROOT', 'relative/workspaces'],
  ['CI_STEP_TIMEOUT_MS', '999'],
  ['CI_STEP_TIMEOUT_MS', '86400001'],
  ['CI_TOTAL_TIMEOUT_MS', '86400001'],
  ['CI_MAX_OUTPUT_BYTES', '1023'],
  ['CI_MAX_OUTPUT_BYTES', '1048577'],
  ['CI_LEASE_MS', '9999'],
  ['CI_LEASE_MS', '300001'],
  ['CI_CONCURRENCY', '0'],
  ['CI_CONCURRENCY', '9'],
  ['RELEASE_SSH_HOST', 'bad host'],
  ['RELEASE_SSH_HOST', 'host;whoami'],
  ['RELEASE_SSH_HOST', 'host\u0000name'],
  ['RELEASE_SSH_USER', 'BadUser'],
  ['RELEASE_SSH_USER', 'release;user'],
  ['RELEASE_SSH_USER', 'release\u0000user'],
  ['RELEASE_SSH_PRIVATE_KEY_PATH', 'relative/key'],
  ['RELEASE_SSH_KNOWN_HOSTS_PATH', 'relative/known_hosts'],
  ['RELEASE_REMOTE_ROOT', '/srv/apps/../escape'],
  ['RELEASE_REMOTE_ROOT', '/'],
  ['RELEASE_REMOTE_ROOT', '/srv/apps/target root'],
  ['RELEASE_REMOTE_ROOT', '/srv/apps;whoami'],
  ['RELEASE_REMOTE_ROOT', '/srv/apps/target\u0000'],
  ['RELEASE_ARTIFACT_ROOT', 'relative/artifacts'],
  ['RELEASE_RETENTION', '1'],
  ['RELEASE_RETENTION', '21'],
  ['RELEASE_HEALTH_URL', 'http://example.com:3000/health'],
  ['RELEASE_HEALTH_URL', 'http://127.0.0.1:3000/health?token=abc'],
  ['RELEASE_HEALTH_URL', 'http://127.0.0.1:3000/../admin'],
  ['RELEASE_HEALTH_URL', 'https://127.0.0.1:3000/health'],
  ['RELEASE_HEALTH_ATTEMPTS', '0'],
  ['RELEASE_HEALTH_ATTEMPTS', '21'],
  ['RELEASE_HEALTH_INTERVAL_MS', '99'],
  ['RELEASE_HEALTH_REQUEST_TIMEOUT_MS', '10001'],
  ['RELEASE_TIMEOUT_MS', '999'],
  ['RELEASE_TIMEOUT_MS', '86400001'],
  ['RELEASE_MAX_OUTPUT_BYTES', '1023'],
  ['RELEASE_MAX_OUTPUT_BYTES', '1048577'],
  ['RELEASE_LEASE_MS', '9999'],
  ['RELEASE_LEASE_MS', '300001'],
] as const) {
  test(`rejects invalid worker ${field}`, () => {
    assert.throws(
      () => parseWorkerEnvironment({ ...validWorkerEnvironment, [field]: value }),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        error.fields.includes(field as string) &&
        !/relative\/workspaces|user:secret|127\.0\.0\.1/.test(error.message),
    );
  });
}

test('rejects a total timeout shorter than a step timeout', () => {
  assert.throws(
    () =>
      parseWorkerEnvironment({
        ...validWorkerEnvironment,
        CI_STEP_TIMEOUT_MS: '120000',
        CI_TOTAL_TIMEOUT_MS: '119999',
        CI_LEASE_MS: '300000',
      }),
    (error: unknown) =>
      error instanceof ConfigurationError &&
      error.fields.includes('CI_TOTAL_TIMEOUT_MS'),
  );
});

test('requires a sufficiently long GitHub webhook secret', () => {
  assert.equal(
    parseApiEnvironment(validEnvironment).GITHUB_WEBHOOK_SECRET,
    'phase3-test-webhook-secret',
  );
  assert.throws(
    () => parseApiEnvironment({ ...validEnvironment, GITHUB_WEBHOOK_SECRET: 'short' }),
    (error: unknown) =>
      error instanceof ConfigurationError &&
      /GITHUB_WEBHOOK_SECRET/.test(error.message),
  );
});

for (const [field, value] of [
  ['PORT', '3000oops'],
  ['PORT', '70000'],
  ['LOG_LEVEL', 'verbose'],
  ['MONGODB_URI', 'https://example.test/mongo'],
  ['REDIS_URL', 'https://example.test/redis'],
] as const) {
  test(`rejects invalid ${field}`, () => {
    assert.throws(
      () => parseApiEnvironment({ ...validEnvironment, [field]: value }),
      (error: unknown) => {
        if (!(error instanceof ConfigurationError)) return false;
        assert.match(error.message, new RegExp(field));
        assert.doesNotMatch(error.message, /secret|example\.test/);
        return true;
      },
    );
  });
}

test('does not include arbitrary error messages in structured logs', () => {
  const logged = errorForLog(
    new Error('failed mongodb://alice:hunter2@db.internal/releasedeck'),
  );
  assert.doesNotMatch(JSON.stringify(logged), /hunter2|db\.internal/);
  assert.deepEqual(logged, { name: 'Error' });
});

test('only includes conventional error codes in structured logs', () => {
  const refused = Object.assign(new Error('connection details'), {
    code: 'ECONNREFUSED',
  });
  assert.deepEqual(errorForLog(refused), { name: 'Error', code: 'ECONNREFUSED' });
  const unsafe = Object.assign(new Error('connection details'), {
    code: 'secret-value',
  });
  assert.deepEqual(errorForLog(unsafe), { name: 'Error' });
});

test('dependency errors retain safe diagnostic metadata', () => {
  const connectionError = Object.assign(new Error('redis://user:secret@localhost'), {
    code: 'ECONNREFUSED',
  });
  const logged = errorForLog(new DependencyError('redis', connectionError));
  assert.deepEqual(logged, {
    name: 'DependencyError',
    code: 'ECONNREFUSED',
    dependency: 'redis',
  });
  assert.doesNotMatch(JSON.stringify(logged), /secret|localhost/);
});

test('accepts MongoDB multi-host and SRV URLs', () => {
  assert.equal(
    parseApiEnvironment({
      ...validEnvironment,
      MONGODB_URI: 'mongodb://host1:27017,host2:27018/releasedeck?replicaSet=rs0',
    }).MONGODB_URI,
    'mongodb://host1:27017,host2:27018/releasedeck?replicaSet=rs0',
  );
  assert.equal(
    parseApiEnvironment({
      ...validEnvironment,
      MONGODB_URI: 'mongodb+srv://cluster.example/releasedeck',
    }).MONGODB_URI,
    'mongodb+srv://cluster.example/releasedeck',
  );
});

test('rejects URLs without a host', () => {
  assert.throws(
    () => parseApiEnvironment({ ...validEnvironment, MONGODB_URI: 'mongodb://' }),
    ConfigurationError,
  );
  assert.throws(
    () => parseApiEnvironment({ ...validEnvironment, REDIS_URL: 'redis://' }),
    ConfigurationError,
  );
});
