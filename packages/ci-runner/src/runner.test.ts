import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  access as fileAccess,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';

import {
  CiCleanupError,
  CiStepError,
  ProcessCancelledError,
  ProcessTimeoutError,
  createCiRunner,
  createWorkspaceManager,
  defaultProcessRunner,
} from './index.js';

const execFileAsync = promisify(execFile);
const deploymentId = '123e4567-e89b-12d3-a456-426614174000';

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    shell: false,
    env: { ...process.env, GIT_EDITOR: 'true' },
  });
  return result.stdout.trim();
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `releasedeck-${prefix}-`));
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function stopProcess(pid: number): Promise<void> {
  if (!processIsRunning(pid)) return;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch(
      () => undefined,
    );
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process may have exited after the liveness check.
    }
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await fileAccess(path);
      return;
    } catch {
      await delay(10);
    }
  }
  await fileAccess(path);
}

test('workspaces are unique, constrained, idempotently cleaned, and preserve siblings', async () => {
  const root = await temporaryDirectory('workspace');
  try {
    const manager = createWorkspaceManager(root);
    const [first, second] = await Promise.all([manager.create(), manager.create()]);
    assert.notEqual(first.path, second.path);
    const sentinel = join(root, 'sentinel.txt');
    await writeFile(sentinel, 'keep');
    await Promise.all([
      first.cleanup(),
      first.cleanup(),
      second.cleanup(),
      second.cleanup(),
    ]);
    await assert.rejects(fileAccess(first.path));
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('process output is bounded and timeout cancellation reports the bounded result', async () => {
  const root = await temporaryDirectory('process');
  try {
    const output = await defaultProcessRunner.run(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(1000))'],
      {
        cwd: root,
        outputLimitBytes: 32,
        timeoutMs: 5_000,
      },
    );
    assert.equal(output.stdout.length, 32);
    assert.equal(output.stdoutTruncated, true);
    const unicodeOutput = await defaultProcessRunner.run(
      process.execPath,
      ['-e', 'process.stdout.write("é".repeat(1000))'],
      {
        cwd: root,
        outputLimitBytes: 32,
        timeoutMs: 5_000,
      },
    );
    assert.ok(Buffer.byteLength(unicodeOutput.stdout, 'utf8') <= 32);
    assert.equal(unicodeOutput.stdoutTruncated, true);

    const timeoutStarted = Date.now();
    await assert.rejects(
      defaultProcessRunner.run(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 5_000)'],
        {
          cwd: root,
          timeoutMs: 100,
          killGraceMs: 100,
        },
      ),
      (error: unknown) => error instanceof ProcessTimeoutError,
    );
    assert.ok(Date.now() - timeoutStarted < 2_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('already-aborted and cancelled processes do not run past bounded termination', async () => {
  const root = await temporaryDirectory('cancel');
  try {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(
      defaultProcessRunner.run(
        process.execPath,
        ['-e', 'throw new Error("must not run")'],
        {
          cwd: root,
          signal: alreadyAborted.signal,
        },
      ),
      (error: unknown) =>
        error instanceof ProcessCancelledError && error.result.durationMs === 0,
    );

    let runnerProcessCalls = 0;
    const alreadyCancelledRunner = createCiRunner({
      workspaceRoot: join(root, 'runner-workspaces'),
      processRunner: {
        async run(_command, _args, options) {
          runnerProcessCalls += 1;
          assert.equal(options.signal?.aborted, true);
          throw new ProcessCancelledError({
            command: 'git',
            args: [],
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 0,
          });
        },
      },
    });
    await assert.rejects(
      alreadyCancelledRunner.run({
        deploymentId,
        repositoryUrl: 'file:///fixture.git',
        commitSha: 'a'.repeat(40),
        signal: alreadyAborted.signal,
      }),
      ProcessCancelledError,
    );
    assert.equal(runnerProcessCalls, 1);

    const controller = new AbortController();
    const cancellation = defaultProcessRunner.run(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 5_000)'],
      { cwd: root, signal: controller.signal, killGraceMs: 100 },
    );
    setTimeout(() => controller.abort(), 50).unref();
    const started = Date.now();
    await assert.rejects(
      cancellation,
      (error: unknown) => error instanceof ProcessCancelledError,
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation settles only after descendants exit and the workspace is removable', async () => {
  const root = await temporaryDirectory('cancel-tree');
  const workspace = join(root, 'workspace');
  const pidFile = join(workspace, 'descendant.pid');
  let descendantPid: number | undefined;
  try {
    await mkdir(workspace);
    const descendantCode = [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'setInterval(() => {}, 5000);',
    ].join('');
    const parentCode = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { stdio: "ignore" });`,
      'setInterval(() => {}, 5000);',
    ].join('');
    const controller = new AbortController();
    const cancellation = defaultProcessRunner.run(
      process.execPath,
      ['-e', parentCode],
      { cwd: workspace, signal: controller.signal, killGraceMs: 100 },
    );
    await waitForFile(pidFile);
    descendantPid = Number(await readFile(pidFile, 'utf8'));
    assert.equal(Number.isSafeInteger(descendantPid), true);

    controller.abort();
    await assert.rejects(cancellation, ProcessCancelledError);

    assert.equal(processIsRunning(descendantPid), false);
    await rm(workspace, { recursive: true });
    await assert.rejects(fileAccess(workspace));
  } finally {
    if (descendantPid !== undefined) await stopProcess(descendantPid);
    await rm(root, { recursive: true, force: true });
  }
});

test('timeout terminates a descendant that inherits the process tree', async () => {
  const root = await temporaryDirectory('descendant');
  const marker = join(root, 'descendant.log');
  try {
    const descendantCode = [
      'const fs = require("node:fs");',
      `const marker = ${JSON.stringify(marker)};`,
      'const timer = setInterval(() => fs.appendFileSync(marker, "x"), 20);',
      'setTimeout(() => clearInterval(timer), 1500);',
    ].join('');
    const parentCode = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { stdio: "ignore" });`,
      'setInterval(() => {}, 5000);',
    ].join('');
    await writeFile(marker, '');
    await assert.rejects(
      defaultProcessRunner.run(process.execPath, ['-e', parentCode], {
        cwd: root,
        timeoutMs: 100,
        killGraceMs: 100,
      }),
      ProcessTimeoutError,
    );
    await delay(250);
    const after = await readFile(marker, 'utf8');
    await delay(150);
    assert.equal(await readFile(marker, 'utf8'), after);
  } finally {
    await delay(1_600);
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup refuses symlink replacement and can retry after the path is restored', async () => {
  const root = await temporaryDirectory('symlink-cleanup');
  const sentinel = join(root, 'sentinel');
  try {
    await mkdir(sentinel);
    await writeFile(join(sentinel, 'keep.txt'), 'keep');
    const workspace = await createWorkspaceManager(root).create();
    await rm(workspace.path, { recursive: true, force: true });
    try {
      await symlink(
        sentinel,
        workspace.path,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (
        process.platform === 'win32' &&
        (error as NodeJS.ErrnoException).code === 'EPERM'
      )
        return;
      throw error;
    }
    await assert.rejects(workspace.cleanup(), /original allocation/);
    assert.equal(await readFile(join(sentinel, 'keep.txt'), 'utf8'), 'keep');
    await rm(workspace.path, { recursive: true, force: true });
    await mkdir(workspace.path);
    await workspace.cleanup();
    await workspace.cleanup();
    await assert.rejects(fileAccess(workspace.path));
    assert.equal(await readFile(join(sentinel, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup failure preserves the prior CI error through an explicit contract', async () => {
  const root = await temporaryDirectory('cleanup-error');
  try {
    const runner = createCiRunner({
      workspaceRoot: root,
      workspaceManager: {
        async create() {
          return {
            path: root,
            async cleanup() {
              throw new Error('cleanup unavailable');
            },
          };
        },
      },
      processRunner: {
        async run() {
          throw new Error('stage unavailable');
        },
      },
    });
    await assert.rejects(
      runner.run({
        deploymentId,
        repositoryUrl: 'file:///fixture.git',
        commitSha: 'a'.repeat(40),
      }),
      (error: unknown) =>
        error instanceof CiCleanupError &&
        error.cleanupError instanceof Error &&
        error.cleanupError.message === 'cleanup unavailable' &&
        error.executionError instanceof Error &&
        error.executionError.message === 'stage unavailable',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner fetches the requested commit and runs fixed npm CI stages in order', async () => {
  const root = await temporaryDirectory('git');
  const source = join(root, 'source');
  const workspaces = join(root, 'workspaces');
  try {
    await mkdir(source, { recursive: true });
    await git(source, ['init', '--quiet']);
    await git(source, ['config', 'user.email', 'ci@example.invalid']);
    await git(source, ['config', 'user.name', 'CI fixture']);
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'ci-fixture',
        version: '1.0.0',
        scripts: {
          test: 'node -e "process.stdout.write(\\"test\\")"',
          build: 'node -e "process.stdout.write(\\"build\\")"',
        },
      }),
    );
    await writeFile(
      join(source, 'package-lock.json'),
      JSON.stringify({
        name: 'ci-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'ci-fixture', version: '1.0.0' } },
      }),
    );
    await writeFile(join(source, 'README.md'), 'first');
    await git(source, ['add', '.']);
    await git(source, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'first',
    ]);
    const firstSha = await git(source, ['rev-parse', 'HEAD']);
    await writeFile(join(source, 'README.md'), 'second');
    await git(source, ['add', 'README.md']);
    await git(source, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'second',
    ]);
    const secondSha = await git(source, ['rev-parse', 'HEAD']);

    const stages: string[] = [];
    const completed: string[] = [];
    let preparedWorkspace: string | undefined;
    const result = await createCiRunner({
      workspaceRoot: workspaces,
      limits: {
        totalTimeoutMs: 60_000,
        checkoutTimeoutMs: 10_000,
        installTimeoutMs: 30_000,
        testTimeoutMs: 10_000,
        buildTimeoutMs: 10_000,
      },
    }).run(
      {
        deploymentId,
        repositoryUrl: pathToFileURL(source).href,
        commitSha: firstSha,
      },
      {
        onStageStarted: (stage) => {
          stages.push(stage);
        },
        onStageCompleted: (stage) => {
          completed.push(stage.stage);
        },
        async onBuildReady(context) {
          preparedWorkspace = context.workspacePath;
          assert.equal(context.deploymentId, deploymentId);
          assert.equal(context.commitSha, firstSha);
          assert.equal(context.packageManager, 'npm');
          assert.equal(context.buildResult.stage, 'BUILD');
          assert.equal(
            await readFile(join(context.workspacePath, 'README.md'), 'utf8'),
            'first',
          );
        },
      },
    );
    assert.equal(result.commitSha, firstSha);
    assert.deepEqual(stages, ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD']);
    assert.deepEqual(completed, ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD']);
    assert.deepEqual(
      result.stages.map((stage) => stage.stage),
      ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD'],
    );
    assert.equal(preparedWorkspace, result.workspacePath);
    await assert.rejects(fileAccess(result.workspacePath));
    assert.notEqual(firstSha, secondSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact preparation failure is a BUILD failure and still cleans the workspace', async () => {
  const root = await temporaryDirectory('artifact-failure');
  const workspaceRoot = join(root, 'workspaces');
  const preparationFailure = new Error('archive unavailable');
  let failedStage: string | undefined;
  let failedError: unknown;
  try {
    const runner = createCiRunner({
      workspaceRoot,
      processRunner: {
        async run(command, args, options) {
          if (args[0] === 'init') {
            await writeFile(join(options.cwd, 'package-lock.json'), '{}');
          }
          return {
            command,
            args,
            exitCode: 0,
            signal: null,
            stdout: args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 0,
          };
        },
      },
    });
    await assert.rejects(
      runner.run(
        {
          deploymentId,
          repositoryUrl: 'file:///fixture.git',
          commitSha: 'a'.repeat(40),
        },
        {
          onBuildReady() {
            throw preparationFailure;
          },
          onStageFailed(stage, error) {
            failedStage = stage;
            failedError = error;
          },
        },
      ),
      (error: unknown) =>
        error instanceof CiStepError &&
        error.stage === 'BUILD' &&
        error.result?.exitCode === 0 &&
        error.cause === preparationFailure,
    );
    assert.equal(failedStage, 'BUILD');
    assert.equal(failedError instanceof CiStepError, true);
    const entries = await import('node:fs/promises').then(({ readdir }) =>
      readdir(workspaceRoot),
    );
    assert.deepEqual(entries, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a pnpm lockfile selects only the fixed pnpm command policy', async () => {
  const root = await temporaryDirectory('pnpm-policy');
  const calls: string[] = [];
  try {
    const runner = createCiRunner({
      workspaceRoot: join(root, 'workspaces'),
      processRunner: {
        async run(command, args, options) {
          calls.push(`${command} ${args.join(' ')}`);
          if (args[0] === 'init') {
            await writeFile(join(options.cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
          }
          return {
            command,
            args,
            exitCode: 0,
            signal: null,
            stdout: args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 0,
          };
        },
      },
    });

    await runner.run({
      deploymentId,
      repositoryUrl: 'file:///fixture.git',
      commitSha: 'a'.repeat(40),
    });

    assert.ok(calls.includes('pnpm install --frozen-lockfile'));
    assert.ok(calls.includes('pnpm test'));
    assert.ok(calls.includes('pnpm run build'));
    assert.equal(
      calls.some((call) => call.startsWith('npm ')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('install rejects missing or ambiguous supported lockfiles before commands', async () => {
  const root = await temporaryDirectory('lockfiles');
  try {
    const runner = createCiRunner({
      workspaceRoot: join(root, 'workspaces'),
      processRunner: {
        async run(command, args, options) {
          if (args[0] === 'init') {
            await writeFile(join(options.cwd, 'package-lock.json'), '{}');
            await writeFile(join(options.cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
          }
          return {
            command,
            args,
            exitCode: 0,
            signal: null,
            stdout: args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 0,
          };
        },
      },
    });
    await assert.rejects(
      runner.run({
        deploymentId,
        repositoryUrl: 'file:///fixture.git',
        commitSha: 'a'.repeat(40),
      }),
      (error: unknown) => error instanceof CiStepError && error.stage === 'INSTALL',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a non-zero fixed stage stops subsequent stages and cleans the workspace', async () => {
  const root = await temporaryDirectory('failure');
  const workspaceRoot = join(root, 'workspaces');
  const calls: string[] = [];
  try {
    const runner = createCiRunner({
      workspaceRoot,
      processRunner: {
        async run(command, args, options) {
          calls.push(`${command} ${args.join(' ')}`);
          if (args[0] === 'init')
            await writeFile(join(options.cwd, 'package-lock.json'), '{}');
          const exitCode = args[0] === 'test' ? 1 : 0;
          const stdout = args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : '';
          return {
            command,
            args,
            exitCode,
            signal: null,
            stdout,
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 0,
          };
        },
      },
    });
    await assert.rejects(
      runner.run({
        deploymentId,
        repositoryUrl: 'file:///fixture.git',
        commitSha: 'a'.repeat(40),
      }),
      (error: unknown) => error instanceof CiStepError && error.stage === 'TEST',
    );
    assert.equal(
      calls.some((call) => call.includes('build')),
      false,
    );
    const entries = await import('node:fs/promises').then(({ readdir }) =>
      readdir(workspaceRoot),
    );
    assert.deepEqual(entries, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
