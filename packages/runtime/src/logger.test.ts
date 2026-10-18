import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

test('real structured logger redacts App configuration, JWT, checkout token and helper context', async () => {
  const keys = [
    'GITHUB_APP_ID',
    'GITHUB_APP_INSTALLATION_ID',
    'GITHUB_APP_PRIVATE_KEY_PATH',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_JWT',
    'RELEASEDECK_CHECKOUT_TOKEN',
    'RELEASEDECK_CHECKOUT_PATH',
  ];
  const fields = Object.fromEntries(keys.map((key) => [key, `secret-canary-${key}`]));
  const code = `import {createLogger} from './src/logger.ts'; const fields=${JSON.stringify(fields)}; createLogger().info({...fields, nested:fields}, 'safe event');`;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    code,
  ]);
  assert.equal(stdout.includes('secret-canary-'), false);
  const logged = JSON.parse(stdout) as Record<string, unknown>;
  for (const key of keys) {
    assert.equal(logged[key], '[Redacted]');
    assert.equal((logged.nested as Record<string, unknown>)[key], '[Redacted]');
  }
  assert.equal(logged.msg, 'safe event');
});
