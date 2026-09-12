import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, access as fileAccess } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

import {
  CiStepError,
  ProcessTimeoutError,
  createCiRunner,
  createWorkspaceManager,
  defaultProcessRunner,
} from './index.js';

const execFileAsync = promisify(execFile);
const deploymentId = '123e4567-e89b-12d3-a456-426614174000';

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, shell: false });
  return result.stdout.trim();
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `releasedeck-${prefix}-`));
}

test('workspaces are unique, constrained, idempotently cleaned, and preserve siblings', async () => {
  const root = await temporaryDirectory('workspace');
  try {
    const manager = createWorkspaceManager(root);
    const [first, second] = await Promise.all([manager.create(), manager.create()]);
    assert.notEqual(first.path, second.path);
    const sentinel = join(root, 'sentinel.txt');
    await writeFile(sentinel, 'keep');
    await Promise.all([first.cleanup(), first.cleanup(), second.cleanup(), second.cleanup()]);
    await assert.rejects(fileAccess(first.path));
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('process output is bounded and timeout cancellation reports the bounded result', async () => {
  const root = await temporaryDirectory('process');
  try {
    const output = await defaultProcessRunner.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000))'], {
      cwd: root,
      outputLimitBytes: 32,
      timeoutMs: 5_000,
    });
    assert.equal(output.stdout.length, 32);
    assert.equal(output.stdoutTruncated, true);

    await assert.rejects(
      defaultProcessRunner.run(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
        cwd: root,
        timeoutMs: 100,
        killGraceMs: 100,
      }),
      (error: unknown) => error instanceof ProcessTimeoutError,
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
      JSON.stringify({ name: 'ci-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'ci-fixture', version: '1.0.0' } } }),
    );
    await writeFile(join(source, 'README.md'), 'first');
    await git(source, ['add', '.']);
    await git(source, ['commit', '--quiet', '-m', 'first']);
    const firstSha = await git(source, ['rev-parse', 'HEAD']);
    await writeFile(join(source, 'README.md'), 'second');
    await git(source, ['add', 'README.md']);
    await git(source, ['commit', '--quiet', '-m', 'second']);
    const secondSha = await git(source, ['rev-parse', 'HEAD']);

    const stages: string[] = [];
    const result = await createCiRunner({
      workspaceRoot: workspaces,
      limits: { totalTimeoutMs: 60_000, checkoutTimeoutMs: 10_000, installTimeoutMs: 30_000, testTimeoutMs: 10_000, buildTimeoutMs: 10_000 },
    }).run(
      {
        deploymentId,
        repositoryUrl: pathToFileURL(source).href,
        commitSha: firstSha,
        packageManager: 'npm',
      },
      { onStageStarted: (stage) => stages.push(stage) },
    );
    assert.equal(result.commitSha, firstSha);
    assert.deepEqual(stages, ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD']);
    assert.deepEqual(result.stages.map((stage) => stage.stage), ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD']);
    await assert.rejects(fileAccess(result.workspacePath));
    assert.notEqual(firstSha, secondSha);
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
          if (args[0] === 'init') await writeFile(join(options.cwd, 'package-lock.json'), '{}');
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
      runner.run({ deploymentId, repositoryUrl: 'file:///fixture.git', commitSha: 'a'.repeat(40), packageManager: 'npm' }),
      (error: unknown) => error instanceof CiStepError && error.stage === 'TEST',
    );
    assert.equal(calls.some((call) => call.includes('build')), false);
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(workspaceRoot));
    assert.deepEqual(entries, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
