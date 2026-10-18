import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  defaultCommandExecutor,
  prepareRelease,
  type CommandExecutor,
} from './index.js';

const metadata = {
  projectId: '11111111-1111-4111-8111-111111111111',
  deploymentId: '22222222-2222-4222-8222-222222222222',
  commitSha: 'a'.repeat(40),
};

test('real archive preserves application files and only trusted release metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck real archive '));
  const workspacePath = join(root, 'workspace');
  const artifactRoot = join(root, 'artifacts');
  const extracted = join(root, 'extracted');
  const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = [];
  const executor: CommandExecutor = {
    async run(command, args, options) {
      calls.push({ command, args, timeoutMs: options.timeoutMs });
      assert.equal(options.outputLimitBytes, 4096);
      return defaultCommandExecutor.run(command, args, options);
    },
  };
  try {
    await mkdir(workspacePath);
    await mkdir(extracted);
    await writeFile(
      join(workspacePath, 'ecosystem.config.cjs'),
      'module.exports = { apps: [] };',
    );
    await mkdir(join(workspacePath, 'dist'));
    await writeFile(
      join(workspacePath, 'dist', 'server.mjs'),
      'console.log("application");',
    );
    await mkdir(join(workspacePath, 'node_modules', 'dependency'), { recursive: true });
    await writeFile(
      join(workspacePath, 'node_modules', 'dependency', 'index.js'),
      'module.exports = {};',
    );
    for (const path of [
      '.git',
      '.ci',
      '.cache',
      '.tmp',
      '.npm-cache',
      '.corepack-cache',
      'node_modules/.cache',
    ]) {
      await mkdir(join(workspacePath, path), { recursive: true });
      await writeFile(join(workspacePath, path, 'excluded'), 'must not ship');
    }
    await writeFile(join(workspacePath, '.env'), 'MUST_NOT_SHIP=secret');
    await mkdir(join(workspacePath, '.releasedeck-release'));
    for (const name of ['project-id', 'deployment-id', 'commit-sha', 'attacker-only']) {
      await writeFile(join(workspacePath, '.releasedeck-release', name), 'untrusted');
    }
    const prepared = await prepareRelease(
      {
        ...metadata,
        workspacePath,
        artifactRoot,
        timeoutMs: 30000,
        outputLimitBytes: 4096,
      },
      executor,
    );
    assert.deepEqual(
      calls.map((call) => call.command),
      ['tar', 'tar', 'gzip'],
    );
    assert.equal(calls[0]!.args[1], 'release.tar');
    assert.deepEqual(calls[1]!.args, ['-rf', 'release.tar', '.releasedeck-release']);
    assert.ok(
      calls.every(
        (call, index) => index === 0 || call.timeoutMs <= calls[index - 1]!.timeoutMs,
      ),
    );
    const archiveCwd = dirname(prepared.archivePath);
    const listed = await defaultCommandExecutor.run('tar', ['-tzf', 'release.tar.gz'], {
      cwd: archiveCwd,
      timeoutMs: 10000,
      outputLimitBytes: 65536,
    });
    assert.equal(listed.exitCode, 0, listed.stderr);
    const entries = listed.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((name) => name.replace(/^\.\//, ''));
    for (const name of ['project-id', 'deployment-id', 'commit-sha']) {
      assert.equal(
        entries.filter((entry) => entry === `.releasedeck-release/${name}`).length,
        1,
      );
    }
    assert.ok(
      !entries.some(
        (entry) =>
          entry.includes('attacker-only') ||
          entry.endsWith('/excluded') ||
          entry === '.env',
      ),
    );
    const result = await defaultCommandExecutor.run(
      'tar',
      ['-xzf', 'release.tar.gz', '-C', extracted.replaceAll('\\', '/')],
      { cwd: archiveCwd, timeoutMs: 10000, outputLimitBytes: 4096 },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    for (const [name, value] of [
      ['project-id', metadata.projectId],
      ['deployment-id', metadata.deploymentId],
      ['commit-sha', metadata.commitSha],
    ]) {
      assert.equal(
        await readFile(join(extracted, '.releasedeck-release', name!), 'utf8'),
        value,
      );
    }
    assert.equal(
      await readFile(join(extracted, 'dist', 'server.mjs'), 'utf8'),
      'console.log("application");',
    );
    assert.equal(
      await readFile(join(extracted, 'node_modules', 'dependency', 'index.js'), 'utf8'),
      'module.exports = {};',
    );

    await t.test(
      'Windows-produced archive extracts with Linux tar in WSL',
      { skip: process.platform !== 'win32' },
      async (linuxTest) => {
        try {
          await promisify(execFile)('wsl.exe', ['--', 'true']);
        } catch {
          linuxTest.skip('WSL is unavailable');
          return;
        }
        const script = `set -eu
archive=$(wslpath -u "$1")
scratch=$(mktemp -d /tmp/releasedeck-archive-test.XXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
tar -xzf "$archive" -C "$scratch"
test "$(cat "$scratch/.releasedeck-release/project-id")" = "$2"
test "$(cat "$scratch/.releasedeck-release/deployment-id")" = "$3"
test "$(cat "$scratch/.releasedeck-release/commit-sha")" = "$4"
test -f "$scratch/ecosystem.config.cjs"
test -f "$scratch/dist/server.mjs"
test ! -e "$scratch/.releasedeck-release/attacker-only"
test ! -e "$scratch/.env"
test ! -e "$scratch/.git"
`;
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            'wsl.exe',
            [
              '--exec',
              'sh',
              '-s',
              '--',
              prepared.archivePath.replaceAll('\\', '/'),
              metadata.projectId,
              metadata.deploymentId,
              metadata.commitSha,
            ],
            { windowsHide: true },
          );
          let stderr = '';
          child.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });
          child.on('error', reject);
          child.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(stderr || `WSL exited ${code}`)),
          );
          child.stdin.end(script);
        });
      },
    );
    await t.test(
      'repository metadata links cannot import outside content',
      async () => {
        const outside = join(root, 'outside-metadata');
        await mkdir(outside);
        await writeFile(join(outside, 'attacker-only'), 'outside workspace');
        await rm(join(workspacePath, '.releasedeck-release'), { recursive: true });
        await symlink(
          outside,
          join(workspacePath, '.releasedeck-release'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        const linked = await prepareRelease({
          ...metadata,
          workspacePath,
          artifactRoot: join(root, 'linked-artifacts'),
        });
        const contents = await defaultCommandExecutor.run(
          'tar',
          ['-tzf', 'release.tar.gz'],
          {
            cwd: dirname(linked.archivePath),
            timeoutMs: 10000,
            outputLimitBytes: 65536,
          },
        );
        assert.equal(contents.exitCode, 0, contents.stderr);
        assert.ok(!contents.stdout.includes('attacker-only'));
        assert.ok(contents.stdout.includes('.releasedeck-release/project-id'));
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preparation still rejects workspace-contained artifacts and invalid ecosystem files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-archive-safety-'));
  const workspacePath = join(root, 'workspace');
  const artifactRoot = join(root, 'artifacts');
  try {
    await mkdir(workspacePath);
    for (const inside of [workspacePath, join(workspacePath, 'artifacts')]) {
      await assert.rejects(
        prepareRelease({ ...metadata, workspacePath, artifactRoot: inside }),
        /artifact root cannot be inside/,
      );
    }
    await assert.rejects(
      prepareRelease({ ...metadata, workspacePath, artifactRoot }),
      /ecosystem.config.cjs is required/,
    );
    await mkdir(join(workspacePath, 'ecosystem.config.cjs'));
    await assert.rejects(
      prepareRelease({ ...metadata, workspacePath, artifactRoot }),
      /ecosystem.config.cjs is required/,
    );
    await rm(join(workspacePath, 'ecosystem.config.cjs'), { recursive: true });
    // A directory junction is available without Windows symlink privileges.
    await symlink(
      root,
      join(workspacePath, 'ecosystem.config.cjs'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      prepareRelease({ ...metadata, workspacePath, artifactRoot }),
      /ecosystem.config.cjs is required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
