import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigurationError, parseApiEnvironment } from './env.js';
import { DependencyError, errorForLog } from './logger.js';

const validEnvironment = {
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
