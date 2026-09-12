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
  assert.equal(environment.CI_LEASE_MS, 2_400_000);
  assert.equal(environment.CI_CONCURRENCY, 1);
  assert.ok(environment.CI_TOTAL_TIMEOUT_MS >= environment.CI_STEP_TIMEOUT_MS);
  assert.ok(environment.CI_LEASE_MS >= environment.CI_TOTAL_TIMEOUT_MS + 60_000);
});

test('accepts bounded worker settings and an absolute workspace root', () => {
  const environment = parseWorkerEnvironment({
    ...validWorkerEnvironment,
    CI_WORKSPACE_ROOT: resolve('phase4-workspaces'),
    CI_STEP_TIMEOUT_MS: '1000',
    CI_TOTAL_TIMEOUT_MS: '61000',
    CI_MAX_OUTPUT_BYTES: '1024',
    CI_LEASE_MS: '121000',
    CI_CONCURRENCY: '8',
  });
  assert.equal(environment.CI_STEP_TIMEOUT_MS, 1_000);
  assert.equal(environment.CI_TOTAL_TIMEOUT_MS, 61_000);
  assert.equal(environment.CI_MAX_OUTPUT_BYTES, 1_024);
  assert.equal(environment.CI_LEASE_MS, 121_000);
  assert.equal(environment.CI_CONCURRENCY, 8);
});

for (const [field, value] of [
  ['CI_WORKSPACE_ROOT', 'relative/workspaces'],
  ['CI_STEP_TIMEOUT_MS', '999'],
  ['CI_STEP_TIMEOUT_MS', '86400001'],
  ['CI_TOTAL_TIMEOUT_MS', '86400001'],
  ['CI_MAX_OUTPUT_BYTES', '1023'],
  ['CI_MAX_OUTPUT_BYTES', '16777217'],
  ['CI_LEASE_MS', '60999'],
  ['CI_LEASE_MS', '172800001'],
  ['CI_CONCURRENCY', '0'],
  ['CI_CONCURRENCY', '9'],
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

test('rejects worker cross-field timeout and lease violations', () => {
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
  assert.throws(
    () =>
      parseWorkerEnvironment({
        ...validWorkerEnvironment,
        CI_TOTAL_TIMEOUT_MS: '120000',
        CI_LEASE_MS: '179999',
      }),
    (error: unknown) =>
      error instanceof ConfigurationError && error.fields.includes('CI_LEASE_MS'),
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
