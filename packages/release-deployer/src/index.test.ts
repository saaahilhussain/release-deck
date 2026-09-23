import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  ACTIVATE_REMOTE_SCRIPT,
  ReleaseDeployerError,
  STAGE_REMOTE_SCRIPT,
  activateRelease,
  buildScpArgs,
  buildSshArgs,
  cleanupPreparedRelease,
  defaultCommandExecutor,
  openPreparedRelease,
  parseReleaseProof,
  prepareRelease,
  stageRelease,
  validateReleaseMetadata,
  validateRemoteRoot,
  type CommandExecutor,
  type CommandOptions,
  type CommandResult,
  type SshTarget,
} from './index.js';

const execFileAsync = promisify(execFile);
const metadata = {
  projectId: '11111111-1111-4111-8111-111111111111',
  deploymentId: '22222222-2222-4222-8222-222222222222',
  commitSha: 'a'.repeat(40),
};
const attemptId = '33333333-3333-4333-8333-333333333333';

function commandResult(
  command: string,
  args: readonly string[],
  stdout = '',
): CommandResult {
  return {
    command,
    args,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
  };
}

function target(root: string): SshTarget {
  return {
    host: 'target.example.com',
    port: 22,
    user: 'deployer',
    privateKeyPath: resolve(root, 'key'),
    knownHostsPath: resolve(root, 'known_hosts'),
    remoteRoot: '/srv/apps',
    timeoutMs: 10_000,
    outputLimitBytes: 4_096,
  };
}

test('validates release identity, remote roots, and strict OpenSSH arguments', () => {
  assert.deepEqual(validateReleaseMetadata(metadata), metadata);
  assert.throws(
    () => validateReleaseMetadata({ ...metadata, commitSha: 'abc' }),
    ReleaseDeployerError,
  );
  assert.equal(validateRemoteRoot('/srv/apps'), '/srv/apps');
  for (const invalid of ['/', 'relative', '/srv/../escape', '/srv//apps']) {
    assert.throws(() => validateRemoteRoot(invalid), ReleaseDeployerError);
  }

  const sshTarget = target(resolve(tmpdir(), 'release-deployer-ssh'));
  const ssh = buildSshArgs(sshTarget, 'sh -s -- safe');
  assert.ok(ssh.includes('BatchMode=yes'));
  assert.ok(ssh.includes('IdentitiesOnly=yes'));
  assert.ok(ssh.includes('StrictHostKeyChecking=yes'));
  assert.ok(ssh.includes('PasswordAuthentication=no'));
  assert.ok(ssh.includes(`UserKnownHostsFile=${sshTarget.knownHostsPath}`));
  assert.ok(ssh.includes(process.platform === 'win32' ? 'NUL' : '/dev/null'));
  const scp = buildScpArgs(
    sshTarget,
    resolve(tmpdir(), 'release.tar.gz'),
    '/tmp/release.tar.gz',
  );
  assert.ok(scp.includes('-B'));
  assert.throws(
    () => buildScpArgs(sshTarget, 'relative', '/tmp/release.tar.gz'),
    ReleaseDeployerError,
  );
});

test('prepares, reopens, verifies, and idempotently cleans a deterministic artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-release-package-'));
  const workspacePath = join(root, 'workspace');
  const artifactRoot = join(root, 'artifacts');
  const calls: { command: string; args: readonly string[] }[] = [];
  const executor: CommandExecutor = {
    async run(command, args) {
      calls.push({ command, args });
      assert.equal(command, 'tar');
      await writeFile(args[1]!, 'archive bytes');
      return commandResult(command, args);
    },
  };
  try {
    await mkdir(workspacePath);
    await writeFile(
      join(workspacePath, 'ecosystem.config.cjs'),
      'module.exports = { apps: [] };',
    );
    const prepared = await prepareRelease(
      { ...metadata, workspacePath, artifactRoot },
      executor,
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.args.includes('--exclude=.git'));
    assert.ok(calls[0]!.args.includes('--exclude=.env'));
    assert.ok(calls[0]!.args.includes('--exclude=.npm-cache'));
    assert.deepEqual(await openPreparedRelease(artifactRoot, metadata), prepared);
    assert.deepEqual(
      await prepareRelease({ ...metadata, workspacePath, artifactRoot }, executor),
      prepared,
    );
    assert.equal(calls.length, 1);

    await writeFile(prepared.archivePath, 'tampered');
    await assert.rejects(
      openPreparedRelease(artifactRoot, metadata),
      ReleaseDeployerError,
    );
    await cleanupPreparedRelease(artifactRoot, metadata.deploymentId);
    await cleanupPreparedRelease(artifactRoot, metadata.deploymentId);
    await assert.rejects(access(prepared.archivePath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stages separately, then activates with exact bounded proof', async () => {
  const root = resolve(tmpdir(), 'releasedeck-release-transport');
  const sshTarget = target(root);
  const releasePath = `${sshTarget.remoteRoot}/${metadata.projectId}/releases/${metadata.deploymentId}`;
  const calls: {
    command: string;
    args: readonly string[];
    options: CommandOptions;
  }[] = [];
  const executor: CommandExecutor = {
    async run(command, args, options) {
      calls.push({ command, args, options });
      if (command === 'scp') return commandResult(command, args);
      if (options.input === STAGE_REMOTE_SCRIPT) {
        return commandResult(
          command,
          args,
          `RELEASE_STAGED project=${metadata.projectId} deployment=${metadata.deploymentId} sha=${metadata.commitSha} path=${releasePath}\n`,
        );
      }
      return commandResult(
        command,
        args,
        `RELEASE_PROOF project=${metadata.projectId} deployment=${metadata.deploymentId} sha=${metadata.commitSha} path=${releasePath} active=${releasePath} pm2=releasedeck-${metadata.projectId} pid=42 nginxValidated=1 nginxReloaded=1\n`,
      );
    },
  };
  const artifact = {
    ...metadata,
    archivePath: resolve(root, 'release.tar.gz'),
    metadataPath: resolve(root, 'metadata.json'),
    archiveSha256: 'b'.repeat(64),
  };
  await stageRelease({ ...metadata, attemptId, artifact, target: sshTarget }, executor);
  const completedAt = new Date('2026-09-21T00:00:00.000Z');
  const proof = await activateRelease(
    {
      ...metadata,
      attemptId,
      target: sshTarget,
      retention: 5,
      now: () => completedAt,
    },
    executor,
  );
  assert.equal(calls[0]?.command, 'scp');
  assert.equal(calls[1]?.options.input, STAGE_REMOTE_SCRIPT);
  assert.equal(calls[2]?.options.input, ACTIVATE_REMOTE_SCRIPT);
  assert.deepEqual(proof, {
    ...metadata,
    remoteReleasePath: releasePath,
    activeTarget: releasePath,
    pm2ProcessName: `releasedeck-${metadata.projectId}`,
    pm2Pid: 42,
    nginx: { validated: true, reloaded: true },
    completedAt,
  });
});

test('proof parsing rejects missing, duplicate, or mismatched evidence', () => {
  const root = '/srv/apps';
  const path = `${root}/${metadata.projectId}/releases/${metadata.deploymentId}`;
  const proof = `RELEASE_PROOF project=${metadata.projectId} deployment=${metadata.deploymentId} sha=${metadata.commitSha} path=${path} active=${path} pm2=releasedeck-${metadata.projectId} pid=9 nginxValidated=1 nginxReloaded=1`;
  assert.equal(parseReleaseProof(proof, metadata, root).pm2Pid, 9);
  for (const invalid of [
    '',
    `${proof}\n${proof}`,
    proof.replace('pid=9', 'pid=0'),
    `${proof} extra=value`,
  ]) {
    assert.throws(
      () => parseReleaseProof(invalid, metadata, root),
      ReleaseDeployerError,
    );
  }
});

test('remote scripts stage immutable content and atomically activate with guarded retention', () => {
  assert.match(STAGE_REMOTE_SCRIPT, /sha256sum/);
  assert.match(STAGE_REMOTE_SCRIPT, /\.staging-/);
  assert.match(STAGE_REMOTE_SCRIPT, /archive-sha256/);
  assert.match(STAGE_REMOTE_SCRIPT, /mv -Tn --.*\|\| true/);
  assert.doesNotMatch(STAGE_REMOTE_SCRIPT, /current/);
  assert.match(ACTIVATE_REMOTE_SCRIPT, /mv -Tf --/);
  assert.match(ACTIVATE_REMOTE_SCRIPT, /flock -w 300/);
  assert.ok((ACTIVATE_REMOTE_SCRIPT.match(/readlink -f/g) ?? []).length >= 2);
  assert.match(ACTIVATE_REMOTE_SCRIPT, /pm2 startOrReload/);
  assert.match(ACTIVATE_REMOTE_SCRIPT, /sudo -n nginx -t/);
  assert.match(ACTIVATE_REMOTE_SCRIPT, /! -name "\$deployment_id"/);
  assert.doesNotMatch(ACTIVATE_REMOTE_SCRIPT, /rm -rf -- "\$root"/);
});

async function runLinuxShell(
  script: string,
  args: readonly string[],
): Promise<{ readonly exitCode: number | null; readonly stdout: string }> {
  const command = process.platform === 'win32' ? 'wsl.exe' : 'sh';
  const commandArgs =
    process.platform === 'win32' ? ['sh', '-s', '--', ...args] : ['-s', '--', ...args];
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`Linux fixture failed (${String(exitCode)}): ${stderr}`));
        return;
      }
      resolveResult({ exitCode, stdout });
    });
    child.stdin.end(script);
  });
}

test('Linux fixture executes staging, activation, proof, and retention', async (t) => {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('wsl.exe', ['sh', '-c', 'command -v tar >/dev/null']);
    } catch {
      t.skip('WSL with POSIX tar is unavailable');
      return;
    }
  }
  const root = `/tmp/releasedeck-release-fixture-${randomUUID()}`;
  const archive = `/tmp/releasedeck-${metadata.deploymentId}-${attemptId}.tar.gz`;
  const secondAttemptId = '77777777-7777-4777-8777-777777777777';
  const secondArchive = `/tmp/releasedeck-${metadata.deploymentId}-${secondAttemptId}.tar.gz`;
  const secondDeploymentId = '88888888-8888-4888-8888-888888888888';
  const oldIds = [
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
  ];
  try {
    const setup = await runLinuxShell(
      String.raw`set -eu
root=$1
project_id=$2
deployment_id=$3
commit_sha=$4
archive=$5
mkdir -p "$root/$project_id/shared" "$root/source/.releasedeck-release" "$root/bin"
printf 'PORT=3000\n' > "$root/$project_id/shared/.env"
printf 'module.exports = { apps: [] };\n' > "$root/source/ecosystem.config.cjs"
printf '%s' "$project_id" > "$root/source/.releasedeck-release/project-id"
printf '%s' "$deployment_id" > "$root/source/.releasedeck-release/deployment-id"
printf '%s' "$commit_sha" > "$root/source/.releasedeck-release/commit-sha"
tar -czf "$archive" -C "$root/source" .
cat > "$root/bin/pm2" <<'EOF'
#!/bin/sh
if test "$1" = pid; then printf '4321\n'; else sleep 0.2; fi
EOF
cat > "$root/bin/sudo" <<'EOF'
#!/bin/sh
test "$1" = -n && shift
exec "$@"
EOF
cat > "$root/bin/nginx" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$root/bin/pm2" "$root/bin/sudo" "$root/bin/nginx"
sha256sum "$archive" | awk '{print $1}'
`,
      [root, metadata.projectId, metadata.deploymentId, metadata.commitSha, archive],
    );
    const archiveSha = setup.stdout.trim();
    await runLinuxShell('cp -- "$1" "$2"\n', [archive, secondArchive]);
    const staged = await Promise.all(
      [
        [archive, attemptId],
        [secondArchive, secondAttemptId],
      ].map(([archivePath, currentAttemptId]) =>
        runLinuxShell(STAGE_REMOTE_SCRIPT, [
          metadata.projectId,
          metadata.deploymentId,
          metadata.commitSha,
          root,
          archivePath!,
          archiveSha,
          currentAttemptId!,
        ]),
      ),
    );
    assert.ok(staged.every((result) => /^RELEASE_STAGED /m.test(result.stdout)));

    await runLinuxShell(
      String.raw`set -eu
releases=$1
shift
for release_id do mkdir -p "$releases/$release_id"; sleep 0.01; done
`,
      [`${root}/${metadata.projectId}/releases`, ...oldIds],
    );
    const activated = await runLinuxShell(
      `PATH="$7/bin:$PATH"\n${ACTIVATE_REMOTE_SCRIPT}`,
      [
        metadata.projectId,
        metadata.deploymentId,
        metadata.commitSha,
        root,
        '2',
        attemptId,
        root,
      ],
    );
    const proof = parseReleaseProof(
      activated.stdout,
      metadata,
      root,
      () => new Date('2026-09-22T00:00:00.000Z'),
    );
    assert.equal(proof.pm2Pid, 4321);
    const inspection = await runLinuxShell(
      String.raw`set -eu
base=$1
deployment_id=$2
test "$(readlink "$base/current")" = "releases/$deployment_id"
test "$(readlink "$base/releases/$deployment_id/.env")" = "$base/shared/.env"
find "$base/releases" -mindepth 1 -maxdepth 1 -type d | wc -l
`,
      [`${root}/${metadata.projectId}`, metadata.deploymentId],
    );
    assert.equal(Number(inspection.stdout.trim()), 2);

    await runLinuxShell(
      String.raw`set -eu
base=$1
source_id=$2
target_id=$3
cp -a -- "$base/releases/$source_id" "$base/releases/$target_id"
printf '%s' "$target_id" > "$base/releases/$target_id/.releasedeck-release/deployment-id"
`,
      [`${root}/${metadata.projectId}`, metadata.deploymentId, secondDeploymentId],
    );
    const concurrent = await Promise.all(
      [metadata.deploymentId, secondDeploymentId].map((currentDeploymentId) =>
        runLinuxShell(`PATH="$7/bin:$PATH"\n${ACTIVATE_REMOTE_SCRIPT}`, [
          metadata.projectId,
          currentDeploymentId,
          metadata.commitSha,
          root,
          '5',
          randomUUID(),
          root,
        ]),
      ),
    );
    for (const [index, currentDeploymentId] of [
      metadata.deploymentId,
      secondDeploymentId,
    ].entries()) {
      assert.equal(
        parseReleaseProof(
          concurrent[index]!.stdout,
          { ...metadata, deploymentId: currentDeploymentId },
          root,
        ).deploymentId,
        currentDeploymentId,
      );
    }
  } finally {
    await runLinuxShell('rm -rf -- "$1"\n', [root]).catch(() => undefined);
  }
});

test('default executor bounds output and rejects an already-cancelled command', async () => {
  const output = await defaultCommandExecutor.run(
    process.execPath,
    ['-e', 'process.stdout.write("é".repeat(1000))'],
    { timeoutMs: 5_000, outputLimitBytes: 31 },
  );
  assert.ok(Buffer.byteLength(output.stdout, 'utf8') <= 31);
  assert.equal(output.stdoutTruncated, true);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    defaultCommandExecutor.run(process.execPath, ['-e', 'process.exit(0)'], {
      signal: controller.signal,
      timeoutMs: 5_000,
      outputLimitBytes: 1_024,
    }),
    (error: unknown) =>
      error instanceof ReleaseDeployerError &&
      error.message === 'release command was cancelled',
  );
});

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
      // The fixture may exit after the liveness check.
    }
  }
}

test('cancellation settles only after a command descendant exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-release-cancel-'));
  const pidFile = join(root, 'descendant.pid');
  let descendantPid: number | undefined;
  try {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const controller = new AbortController();
    const running = defaultCommandExecutor.run(process.execPath, ['-e', script], {
      cwd: root,
      signal: controller.signal,
      timeoutMs: 10_000,
      outputLimitBytes: 1_024,
      killGraceMs: 100,
    });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        descendantPid = Number(await readFile(pidFile, 'utf8'));
        break;
      } catch {
        await delay(10);
      }
    }
    assert.ok(descendantPid);
    controller.abort();
    await assert.rejects(running, ReleaseDeployerError);
    assert.equal(processIsRunning(descendantPid), false);
  } finally {
    if (descendantPid) await stopProcess(descendantPid);
    await rm(root, { recursive: true, force: true });
  }
});
