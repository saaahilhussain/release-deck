import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  createSystemdBuildExecutor,
  type LauncherRequest,
  type BuildExecutor,
} from './build-executor.js';
import { createCiRunner, CiCleanupError } from './runner.js';
import {
  createCiEnvironment,
  defaultProcessRunner,
  ProcessCancelledError,
  ProcessTimeoutError,
  type ProcessResult,
} from './process.js';

const sha = 'a'.repeat(40);
const deploymentId = '123e4567-e89b-12d3-a456-426614174000';
function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: 'npm',
    args: [],
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 5,
    ...overrides,
  };
}

test('actual local child keeps the existing allowlist and isolates ambient Git configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-build-env-'));
  const hostile = {
    MONGODB_URI: 'worker-secret-canary',
    REDIS_URL: 'redis-secret-canary',
    GITHUB_WEBHOOK_SECRET: 'webhook-secret-canary',
    GITHUB_APP_PRIVATE_KEY: 'key-secret-canary',
    GITHUB_APP_ID: '123',
    GITHUB_APP_INSTALLATION_ID: '456',
    GITHUB_TOKEN: 'token-secret-canary',
    GIT_ASKPASS: 'hostile-helper',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: 'hostile',
    SSH_AUTH_SOCK: 'hostile-agent',
    NODE_OPTIONS: '--inspect',
    RELEASE_SSH_PRIVATE_KEY_PATH: 'private-path-canary',
  };
  const saved = new Map(Object.keys(hostile).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, hostile);
    const output = await defaultProcessRunner.run(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { cwd: root, timeoutMs: 5000 },
    );
    const env = JSON.parse(output.stdout) as Record<string, string>;
    for (const key of Object.keys(hostile)) assert.equal(env[key], undefined, key);
    assert.equal(env.HOME, root);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(
      env.GIT_CONFIG_GLOBAL,
      process.platform === 'win32' ? 'NUL' : '/dev/null',
    );
    assert.equal(createCiEnvironment(root).TMPDIR, join(root, '.tmp'));
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('systemd adapter sends only a fixed operation contract and holds one job until verified close', async () => {
  const requests: LauncherRequest[] = [];
  const executor = createSystemdBuildExecutor('/trusted/launcher', async (request) => {
    requests.push(request);
    return { ok: true, workspacePath: resolve('restricted'), result: result() };
  });
  await executor.probe();
  const session = await executor.open(resolve('checkout'));
  await assert.rejects(executor.open(resolve('other')), /one job/);
  await session.run('INSTALL', 'npm', { cwd: session.workspacePath });
  await session.collect();
  await session.close();
  await session.close();
  assert.deepEqual(
    requests.map((x) => x.op),
    ['probe', 'open', 'run', 'collect', 'close'],
  );
  assert.deepEqual(Object.keys(requests[2]!).sort(), [
    'jobId',
    'manager',
    'op',
    'outputLimitBytes',
    'stage',
    'timeoutMs',
  ]);
  assert.equal(JSON.stringify(requests).includes('GITHUB'), false);
});

test('systemd adapter preserves timeout and cancellation semantics and awaits cgroup cancellation', async () => {
  for (const mode of ['timeout', 'cancel'] as const) {
    const controller = new AbortController();
    const ops: string[] = [];
    let cancelled = false;
    const executor = createSystemdBuildExecutor(
      '/trusted/launcher',
      async (request) => {
        ops.push(String(request.op));
        if (request.op === 'run') {
          if (mode === 'cancel') controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        if (request.op === 'cancel') cancelled = true;
        return {
          ok: true,
          workspacePath: resolve('restricted'),
          result: result({ exitCode: 1 }),
          timedOut: mode === 'timeout',
        };
      },
    );
    const session = await executor.open(resolve('checkout'));
    await assert.rejects(
      session.run('TEST', 'npm', {
        cwd: session.workspacePath,
        signal: controller.signal,
      }),
      mode === 'timeout' ? ProcessTimeoutError : ProcessCancelledError,
    );
    if (mode === 'cancel') assert.equal(cancelled, true);
    await session.close();
    assert.equal(ops.at(-1), 'close');
  }
});

test('unavailable, malformed and failed cleanup paths never fall back or unlock an unsafe job', async () => {
  const executor = createSystemdBuildExecutor('/trusted/launcher', async (request) => {
    if (request.op === 'open')
      return { ok: true, workspacePath: resolve('restricted') };
    throw new Error('unavailable');
  });
  await assert.rejects(executor.probe(), /unavailable/);
  const session = await executor.open(resolve('checkout'));
  await assert.rejects(
    session.run('BUILD', 'npm', { cwd: session.workspacePath }),
    /unavailable/,
  );
  await assert.rejects(session.close(), /unavailable/);
  await assert.rejects(executor.open(resolve('other')), /one job/);
  const calls: string[] = [];
  const malformed = createSystemdBuildExecutor('/trusted/launcher', async (request) => {
    calls.push(String(request.op));
    return { ok: true };
  });
  await assert.rejects(malformed.open(resolve('checkout')), /invalid/);
  assert.deepEqual(calls, ['open', 'close']);
});

test('cancellation racing unit creation preserves cancellation after acknowledged teardown', async () => {
  const controller = new AbortController();
  let stopped = false;
  const executor = createSystemdBuildExecutor('/trusted/launcher', async (request) => {
    if (request.op === 'cancel') {
      stopped = true;
      return { ok: true };
    }
    if (request.op === 'run') {
      controller.abort();
      throw new Error('cancelled before unit creation');
    }
    return { ok: true, workspacePath: resolve('restricted') };
  });
  const session = await executor.open(resolve('checkout'));
  await assert.rejects(
    session.run('INSTALL', 'npm', {
      cwd: session.workspacePath,
      signal: controller.signal,
    }),
    ProcessCancelledError,
  );
  assert.equal(stopped, true);
  await session.close();
});

for (const failure of [
  'success',
  'INSTALL',
  'TEST',
  'BUILD',
  'timeout',
  'cancel',
  'exception',
  'cleanup',
] as const) {
  test(`runner separates checkout, collects only after revocation, and cleans both workspaces: ${failure}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'releasedeck-boundary-runner-'));
    const restricted = join(root, 'restricted');
    const events: string[] = [];
    let checkoutPath = '';
    let collected = false;
    const executor: BuildExecutor = {
      probe: async () => undefined,
      async open(path) {
        checkoutPath = path;
        await mkdir(restricted);
        return {
          workspacePath: restricted,
          async run(stage, manager, options) {
            events.push(stage);
            assert.equal(options.cwd, restricted);
            assert.equal(manager, 'npm');
            if (failure === 'timeout') throw new ProcessTimeoutError(result());
            if (failure === 'cancel') throw new ProcessCancelledError(result());
            if (failure === 'exception') throw new Error('executor failed');
            return result({ exitCode: stage === failure ? 1 : 0 });
          },
          async collect() {
            events.push('collect');
            collected = true;
          },
          async close() {
            events.push('close');
            await rm(restricted, { recursive: true });
            if (failure === 'cleanup') throw new Error('cleanup proof unavailable');
          },
        };
      },
    };
    try {
      const execution = createCiRunner({
        workspaceRoot: join(root, 'checkout'),
        buildExecutor: executor,
        processRunner: {
          async run(command, args, options) {
            assert.equal(
              command,
              'git',
              'repository commands cannot use trusted runner',
            );
            assert.notEqual(options.cwd, restricted);
            if (args[0] === 'init')
              await writeFile(join(options.cwd, 'package-lock.json'), '{}');
            if (args[0] === 'fetch') assert.equal(args.at(-1), sha);
            return result({
              command,
              args,
              stdout: args[0] === 'rev-parse' ? sha : '',
            });
          },
        },
      }).run(
        {
          deploymentId,
          repositoryUrl: 'https://github.com/owner/repository.git',
          commitSha: sha,
        },
        {
          onBuildReady(context) {
            assert.equal(collected, true);
            assert.equal(context.workspacePath, restricted);
            events.push('artifact');
          },
        },
      );
      if (failure === 'success') {
        const output = await execution;
        assert.equal(output.commitSha, sha);
        assert.deepEqual(events, [
          'INSTALL',
          'TEST',
          'BUILD',
          'collect',
          'artifact',
          'close',
        ]);
      } else {
        await assert.rejects(execution, failure === 'cleanup' ? CiCleanupError : Error);
        assert.equal(events.at(-1), 'close');
        if (failure !== 'cleanup') assert.equal(events.includes('artifact'), false);
      }
      await assert.rejects(access(checkoutPath));
      await assert.rejects(access(restricted));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
