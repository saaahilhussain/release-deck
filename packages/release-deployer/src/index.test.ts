import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  ACTIVATE_REMOTE_SCRIPT,
  MANUAL_ROLLBACK_REMOTE_SCRIPT,
  PROMOTE_REMOTE_SCRIPT,
  ReleaseDeployerError,
  STAGE_REMOTE_SCRIPT,
  activateRelease,
  buildScpArgs,
  buildSshArgs,
  cleanupPreparedRelease,
  defaultCommandExecutor,
  openPreparedRelease,
  parseReleaseProof,
  promoteRelease,
  prepareRelease,
  rollbackRelease,
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
    healthUrl: 'http://127.0.0.1:3000/health',
    healthAttempts: 3,
    healthIntervalMs: 100,
    healthRequestTimeoutMs: 200,
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
  assert.throws(
    () =>
      buildSshArgs({ ...sshTarget, healthUrl: 'http://example.com/health' }, 'safe'),
    ReleaseDeployerError,
  );
});

test('prepares, reopens, verifies, and idempotently cleans a deterministic artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-release-package-'));
  const workspacePath = join(root, 'workspace');
  const artifactRoot = join(root, 'artifacts');
  const calls: { command: string; args: readonly string[] }[] = [];
  const executor: CommandExecutor = {
    async run(command, args, options) {
      calls.push({ command, args });
      return defaultCommandExecutor.run(command, args, options);
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
    assert.equal(prepared.applicationRoot, '.');
    assert.equal(prepared.build, 'required');
    assert.deepEqual(JSON.parse(await readFile(prepared.metadataPath, 'utf8')), {
      schemaVersion: 2,
      ...metadata,
      applicationRoot: '.',
      build: 'required',
      archiveSha256: prepared.archiveSha256,
    });
    assert.equal(calls.length, 3);
    assert.ok(calls[0]!.args.includes('--exclude=.git'));
    assert.ok(calls[0]!.args.includes('--exclude=.env'));
    assert.ok(calls[0]!.args.includes('--exclude=.npm-cache'));
    assert.deepEqual(await openPreparedRelease(artifactRoot, metadata), prepared);
    assert.deepEqual(
      await prepareRelease({ ...metadata, workspacePath, artifactRoot }, executor),
      prepared,
    );
    assert.equal(calls.length, 3);
    await assert.rejects(
      prepareRelease(
        { ...metadata, workspacePath, artifactRoot, build: 'none' },
        executor,
      ),
      /incompatible prepared artifact/,
    );

    const writeOuterMetadata = async (value: unknown) =>
      writeFile(prepared.metadataPath, `${JSON.stringify(value)}\n`);
    const currentOuter = {
      schemaVersion: 2,
      ...metadata,
      applicationRoot: '.',
      build: 'required',
      archiveSha256: prepared.archiveSha256,
    };
    for (const conflicting of [
      { ...currentOuter, applicationRoot: 'server' },
      { ...currentOuter, build: 'none' },
      { ...currentOuter, applicationRoot: 'server', build: 'none' },
    ]) {
      await writeOuterMetadata(conflicting);
      await assert.rejects(
        openPreparedRelease(artifactRoot, metadata),
        ReleaseDeployerError,
      );
    }
    for (const invalid of [
      { ...currentOuter, applicationRoot: null },
      { ...currentOuter, build: null },
    ]) {
      await writeOuterMetadata(invalid);
      await assert.rejects(
        openPreparedRelease(artifactRoot, metadata),
        ReleaseDeployerError,
      );
    }
    await writeOuterMetadata({
      schemaVersion: 1,
      ...metadata,
      archiveSha256: prepared.archiveSha256,
    });
    await assert.rejects(
      openPreparedRelease(artifactRoot, metadata),
      ReleaseDeployerError,
    );

    await writeOuterMetadata(currentOuter);
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

test('opens a genuine schema-1 archive without current embedded build-plan fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-schema-1-package-'));
  const artifactRoot = join(root, 'artifacts');
  const directory = join(artifactRoot, metadata.deploymentId);
  const embedded = join(directory, '.releasedeck-release');
  try {
    await mkdir(embedded, { recursive: true });
    await Promise.all([
      writeFile(join(embedded, 'project-id'), metadata.projectId),
      writeFile(join(embedded, 'deployment-id'), metadata.deploymentId),
      writeFile(join(embedded, 'commit-sha'), metadata.commitSha),
    ]);
    for (const [command, args] of [
      ['tar', ['-cf', 'release.tar', '.releasedeck-release']],
      ['gzip', ['-n', 'release.tar']],
    ] as const) {
      const result = await defaultCommandExecutor.run(command, args, {
        cwd: directory,
        timeoutMs: 10_000,
        outputLimitBytes: 4096,
      });
      assert.equal(result.exitCode, 0, result.stderr);
    }
    const archivePath = join(directory, 'release.tar.gz');
    const archiveSha256 = createHash('sha256')
      .update(await readFile(archivePath))
      .digest('hex');
    await writeFile(
      join(directory, 'metadata.json'),
      `${JSON.stringify({ schemaVersion: 1, ...metadata, archiveSha256 })}\n`,
    );
    const legacy = await openPreparedRelease(artifactRoot, metadata);
    assert.equal(legacy.applicationRoot, '.');
    assert.equal(legacy.build, 'required');
    assert.equal(legacy.archiveSha256, archiveSha256);
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
    applicationRoot: '.',
    build: 'required' as const,
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

test('promotion and manual rollback parse health and prior-release outcomes strictly', async () => {
  const root = resolve(tmpdir(), 'releasedeck-outcome-parse');
  const sshTarget = target(root);
  const prior = {
    ...metadata,
    deploymentId: '88888888-8888-4888-8888-888888888888',
    commitSha: 'b'.repeat(40),
  };
  const activePath = `${sshTarget.remoteRoot}/${metadata.projectId}/releases/${metadata.deploymentId}`;
  const executor: CommandExecutor = {
    async run(command, args, options) {
      const output =
        options.input === PROMOTE_REMOTE_SCRIPT
          ? `PROMOTION_ROLLBACK_FAILED project=${metadata.projectId} deployment=${prior.deploymentId} sha=${prior.commitSha} candidate=${metadata.deploymentId} candidateSha=${metadata.commitSha} failureCode=restore_unhealthy\n`
          : `MANUAL_ROLLBACK_ACTIVE_RESTORED project=${metadata.projectId} deployment=${metadata.deploymentId} sha=${metadata.commitSha} path=${activePath} active=${activePath} pm2=releasedeck-${metadata.projectId} pid=8 nginxValidated=1 nginxReloaded=1 attempted=${prior.deploymentId} attemptedSha=${prior.commitSha} healthStatus=204 healthAttempts=2\n`;
      return commandResult(command, args, output);
    },
  };
  const promotion = await promoteRelease(
    { ...metadata, attemptId, target: sshTarget, retention: 5 },
    executor,
  );
  assert.equal(promotion.status, 'ROLLBACK_FAILED');
  if (promotion.status === 'ROLLBACK_FAILED')
    assert.deepEqual(promotion.attemptedRestore, prior);
  const rollback = await rollbackRelease(
    {
      ...metadata,
      targetDeploymentId: prior.deploymentId,
      targetCommitSha: prior.commitSha,
      requestId: '44444444-4444-4444-8444-444444444444',
      attemptId,
      target: sshTarget,
      retention: 5,
    },
    executor,
  );
  assert.equal(rollback.status, 'FAILED_ACTIVE_RESTORED');
  if (rollback.status === 'FAILED_ACTIVE_RESTORED') {
    assert.deepEqual(rollback.attemptedRestore, prior);
    assert.equal(rollback.healthProof.statusCode, 204);
  }
});

test('promotion rejects truncated or mismatched remote outcome proof', async () => {
  const sshTarget = target(resolve(tmpdir(), 'releasedeck-outcome-truncation'));
  const output = `PROMOTION_NO_KNOWN_GOOD project=${metadata.projectId} deployment=${metadata.deploymentId} sha=${metadata.commitSha} candidate=${metadata.deploymentId} candidateSha=${metadata.commitSha} failureCode=no_known_good\n`;
  const input = { ...metadata, attemptId, target: sshTarget, retention: 5 };
  await assert.rejects(
    promoteRelease(input, {
      async run(command, args) {
        return { ...commandResult(command, args, output), stdoutTruncated: true };
      },
    }),
    ReleaseDeployerError,
  );
  await assert.rejects(
    promoteRelease(input, {
      async run(command, args) {
        return commandResult(
          command,
          args,
          output.replace(
            `candidate=${metadata.deploymentId}`,
            `candidate=${attemptId}`,
          ),
        );
      },
    }),
    ReleaseDeployerError,
  );
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

const fakePm2 = String.raw`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const state = process.argv[1] + '.state';
const [command, config] = process.argv.slice(2);
if (command === 'jlist') console.log(fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : '[]');
else if (command === 'delete') fs.rmSync(state, {force:true});
else if (command === 'start') {
  if (fs.existsSync(path.join(path.dirname(config), '.fail-start'))) process.exit(1);
  const app = require(config).apps[0];
  fs.writeFileSync(state, JSON.stringify([{name:app.name,pid:4321,pm2_env:{status:'online',pm_exec_path:path.resolve(path.dirname(config),app.script),pm_cwd:path.dirname(config)}}]));
} else process.exit(1);
`;

test('remote scripts stage immutable content and atomically activate with guarded retention', () => {
  assert.match(STAGE_REMOTE_SCRIPT, /sha256sum/);
  assert.match(STAGE_REMOTE_SCRIPT, /\.staging-/);
  assert.match(STAGE_REMOTE_SCRIPT, /archive-sha256/);
  assert.match(STAGE_REMOTE_SCRIPT, /mv -Tn --.*\|\| true/);
  assert.doesNotMatch(STAGE_REMOTE_SCRIPT, /current/);
  assert.match(ACTIVATE_REMOTE_SCRIPT, /mv -Tf --/);
  assert.match(ACTIVATE_REMOTE_SCRIPT, /flock -w 300/);
  assert.ok((ACTIVATE_REMOTE_SCRIPT.match(/readlink -f/g) ?? []).length >= 2);
  assert.match(ACTIVATE_REMOTE_SCRIPT, /pm2 delete/);
  assert.match(ACTIVATE_REMOTE_SCRIPT, /activate_pm2/);
  assert.doesNotMatch(ACTIVATE_REMOTE_SCRIPT, /startOrReload/);
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
mkdir -p "$root/$project_id/shared" "$root/source/.releasedeck-release" "$root/source/server" "$root/bin"
printf 'PORT=3000\n' > "$root/$project_id/shared/.env"
printf 'module.exports={apps:[{name:"releasedeck-%s",cwd:__dirname,script:"./server.cjs"}]};\n' "$project_id" > "$root/source/server/ecosystem.config.cjs"
printf '' > "$root/source/server/server.cjs"
printf '%s' "$project_id" > "$root/source/.releasedeck-release/project-id"
printf '%s' "$deployment_id" > "$root/source/.releasedeck-release/deployment-id"
printf '%s' "$commit_sha" > "$root/source/.releasedeck-release/commit-sha"
printf server > "$root/source/.releasedeck-release/application-root"
printf none > "$root/source/.releasedeck-release/build"
tar -czf "$archive" -C "$root/source" .
cat > "$root/bin/pm2" <<'EOF'
${fakePm2}
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
test "$(readlink "$base/releases/$deployment_id/server/.env")" = "$base/shared/.env"
test ! -e "$base/releases/$deployment_id/.env"
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

test('promotion restores and rechecks healthy A after candidate B fails', async (t) => {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('wsl.exe', ['sh', '-c', 'command -v flock >/dev/null']);
    } catch {
      t.skip('WSL with POSIX flock is unavailable');
      return;
    }
  }
  const root = `/tmp/releasedeck-promotion-${randomUUID()}`;
  const idA = metadata.deploymentId;
  const idB = '88888888-8888-4888-8888-888888888888';
  const shaB = 'b'.repeat(40);
  try {
    await runLinuxShell(
      [
        'set -eu',
        'root=$1 project=$2 a=$3 b=$4 sha_a=$5 sha_b=$6',
        'base="$root/$project"; mkdir -p "$base/shared" "$base/releases/$a/.releasedeck-release" "$base/releases/$b/.releasedeck-release" "$root/bin"',
        'printf x > "$base/shared/.env"',
        'for id in "$a" "$b"; do d="$base/releases/$id"; printf %s "$project" > "$d/.releasedeck-release/project-id"; printf %s "$id" > "$d/.releasedeck-release/deployment-id"; printf x > "$d/.releasedeck-release/archive-sha256"; ln -s "$base/shared/.env" "$d/.env"; printf \'module.exports={apps:[{name:"releasedeck-%s",cwd:__dirname,script:"./server.cjs"}]};\\n\' "$project" > "$d/ecosystem.config.cjs"; printf x > "$d/server.cjs"; done',
        'a_dir="$base/releases/$a"; mkdir "$a_dir/server"; mv "$a_dir/ecosystem.config.cjs" "$a_dir/server/ecosystem.config.cjs"; mv "$a_dir/server.cjs" "$a_dir/server/server.cjs"; rm "$a_dir/.env"; ln -s "$base/shared/.env" "$a_dir/server/.env"; printf server > "$a_dir/.releasedeck-release/application-root"; printf none > "$a_dir/.releasedeck-release/build"',
        'printf %s "$sha_a" > "$base/releases/$a/.releasedeck-release/commit-sha"; printf %s "$sha_b" > "$base/releases/$b/.releasedeck-release/commit-sha"',
        'printf 200 > "$base/releases/$a/.health"; printf 503 > "$base/releases/$b/.health"',
        'ln -s "releases/$a" "$base/current"',
        `cat > "$root/bin/pm2" <<'FAKE'\n${fakePm2}FAKE`,
        "printf '%s\\n' '#!/bin/sh' 'test \"$1\" = -n && shift' 'exec \"$@\"' > \"$root/bin/sudo\"",
        "printf '%s\\n' '#!/bin/sh' 'exit 0' > \"$root/bin/nginx\"",
        'printf \'%s\\n\' \'#!/bin/sh\' \'test "$1" = --noproxy && test "$2" = "*" || exit 7\' \'id=$(basename "$(readlink "$FIXTURE_BASE/current")")\' \'code=$(cat "$FIXTURE_BASE/releases/$id/.health")\' \'printf %s "$code"\' \'test "$code" -lt 400\' > "$root/bin/curl"',
        'chmod +x "$root/bin/pm2" "$root/bin/sudo" "$root/bin/nginx" "$root/bin/curl"',
      ].join('\n'),
      [root, metadata.projectId, idA, idB, metadata.commitSha, shaB],
    );
    const promote = (id: string, sha: string, attempt: string) =>
      runLinuxShell(
        `PATH="\${11}/bin:$PATH" FIXTURE_BASE="\${11}/${metadata.projectId}"\nexport PATH FIXTURE_BASE\n${PROMOTE_REMOTE_SCRIPT}`,
        [
          metadata.projectId,
          id,
          sha,
          root,
          '5',
          attempt,
          'http://127.0.0.1:3000/health',
          '3',
          '100',
          '200',
          root,
        ],
      );
    const legacyCandidate = await promote(
      idB,
      shaB,
      '66666666-6666-4666-8666-666666666666',
    );
    assert.match(
      legacyCandidate.stdout,
      /PROMOTION_NO_KNOWN_GOOD .*failureCode=no_known_good/,
    );
    const legacyCheck = await runLinuxShell(
      'set -eu\nbase=$1; test "$(readlink "$base/current")" = "releases/$2"; test ! -e "$base/known-good"\n',
      [`${root}/${metadata.projectId}`, idB],
    );
    assert.equal(legacyCheck.stdout, '');
    const first = await promote(idA, metadata.commitSha, attemptId);
    assert.match(first.stdout, /PROMOTION_PROMOTED .*healthStatus=200/);
    await runLinuxShell('touch "$1/$2/releases/$3/.fail-start"\n', [
      root,
      metadata.projectId,
      idB,
    ]);
    const failedStart = await promote(idB, shaB, randomUUID());
    assert.match(failedStart.stdout, /PROMOTION_ROLLED_BACK .*healthStatus=200/);
    await runLinuxShell('rm "$1/$2/releases/$3/.fail-start"\n', [
      root,
      metadata.projectId,
      idB,
    ]);
    const candidate = await promote(idB, shaB, '77777777-7777-4777-8777-777777777777');
    assert.match(
      candidate.stdout,
      /PROMOTION_ROLLED_BACK .*candidate=88888888-8888-4888-8888-888888888888 .*healthStatus=200/,
    );
    const check = await runLinuxShell(
      'set -eu\nbase=$1; test "$(readlink "$base/current")" = "releases/$2"; code=$(FIXTURE_BASE="$base" PATH="$3/bin:$PATH" curl --noproxy "*" http://127.0.0.1:3000/health); test "$code" = 200; printf "%s %s\\n" "$(readlink "$base/current")" "$code"\n',
      [`${root}/${metadata.projectId}`, idA, root],
    );
    assert.equal(check.stdout.trim(), `releases/${idA} 200`);
    await runLinuxShell('printf 200 > "$1/$2/releases/$3/.health"\n', [
      root,
      metadata.projectId,
      idB,
    ]);
    const recoveredCandidate = await promote(
      idB,
      shaB,
      '99999999-9999-4999-8999-999999999999',
    );
    assert.match(
      recoveredCandidate.stdout,
      /PROMOTION_PROMOTED .*deployment=88888888-8888-4888-8888-888888888888/,
    );
    const firstRollbackArgs = (
      attempt: string,
      request = '44444444-4444-4444-8444-444444444444',
    ) => [
      metadata.projectId,
      idB,
      shaB,
      idA,
      metadata.commitSha,
      root,
      '5',
      attempt,
      'http://127.0.0.1:3000/health',
      '3',
      '100',
      '200',
      request,
      root,
    ];
    const manual = await runLinuxShell(
      `PATH="\${14}/bin:$PATH" FIXTURE_BASE="\${14}/${metadata.projectId}"\nexport PATH FIXTURE_BASE\n${MANUAL_ROLLBACK_REMOTE_SCRIPT}`,
      firstRollbackArgs('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    );
    assert.match(
      manual.stdout,
      /MANUAL_ROLLBACK_RESTORED .*deployment=22222222-2222-4222-8222-222222222222 .*healthStatus=200/,
    );
    const replay = await runLinuxShell(
      `PATH="\${14}/bin:$PATH" FIXTURE_BASE="\${14}/${metadata.projectId}"\nexport PATH FIXTURE_BASE\n${MANUAL_ROLLBACK_REMOTE_SCRIPT}`,
      firstRollbackArgs('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    );
    assert.match(replay.stdout, /MANUAL_ROLLBACK_RESTORED .*healthStatus=200/);
    await runLinuxShell(
      'set -eu\nbase=$1; printf "%s\\n" "$2" > "$base/known-good"; printf "%s\\n" "$3" > "$base/previous-known-good"\n',
      [`${root}/${metadata.projectId}`, idB, idA],
    );
    const replayAfterPointerSwitch = await runLinuxShell(
      `PATH="\${14}/bin:$PATH" FIXTURE_BASE="\${14}/${metadata.projectId}"\nexport PATH FIXTURE_BASE\n${MANUAL_ROLLBACK_REMOTE_SCRIPT}`,
      firstRollbackArgs('ffffffff-ffff-4fff-8fff-ffffffffffff'),
    );
    assert.match(
      replayAfterPointerSwitch.stdout,
      /MANUAL_ROLLBACK_RESTORED .*healthStatus=200/,
    );
    await runLinuxShell('rm -f -- "$1/$2/current"\n', [root, metadata.projectId]);
    await assert.rejects(
      runLinuxShell(
        `PATH="\${14}/bin:$PATH" FIXTURE_BASE="\${14}/${metadata.projectId}"\nexport PATH FIXTURE_BASE\n${MANUAL_ROLLBACK_REMOTE_SCRIPT}`,
        firstRollbackArgs('acacacac-acac-4aca-8aca-acacacacacac'),
      ),
      /Linux fixture failed \(74\)/,
    );
    await runLinuxShell('ln -s "releases/$3" "$1/$2/current"\n', [
      root,
      metadata.projectId,
      idA,
    ]);
    await assert.rejects(
      runLinuxShell(
        `PATH="\${14}/bin:$PATH" FIXTURE_BASE="\${14}/${metadata.projectId}"\nexport PATH FIXTURE_BASE\n${MANUAL_ROLLBACK_REMOTE_SCRIPT}`,
        firstRollbackArgs(
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          '66666666-6666-4666-8666-666666666666',
        ),
      ),
      /Linux fixture failed \(74\)/,
    );
    await runLinuxShell('rm -f -- "$1/$2/.manual-rollback-request"\n', [
      root,
      metadata.projectId,
    ]);
    await assert.rejects(
      runLinuxShell(
        `PATH="\${14}/bin:$PATH" FIXTURE_BASE="\${14}/${metadata.projectId}"\nexport PATH FIXTURE_BASE\n${MANUAL_ROLLBACK_REMOTE_SCRIPT}`,
        firstRollbackArgs('abababab-abab-4bab-8bab-abababababab'),
      ),
      /Linux fixture failed \(74\)/,
    );
    const manualArgs = (attempt: string) => [
      metadata.projectId,
      idA,
      metadata.commitSha,
      idB,
      shaB,
      root,
      '5',
      attempt,
      'http://127.0.0.1:3000/health',
      '3',
      '100',
      '200',
      '55555555-5555-4555-8555-555555555555',
      root,
    ];
    const stalePreconditionArgs = manualArgs('bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc');
    stalePreconditionArgs[4] = 'c'.repeat(40);
    await assert.rejects(
      runLinuxShell(
        `PATH="\${14}/bin:$PATH" FIXTURE_BASE="\${14}/${metadata.projectId}"\nexport PATH FIXTURE_BASE\n${MANUAL_ROLLBACK_REMOTE_SCRIPT}`,
        stalePreconditionArgs,
      ),
      /Linux fixture failed \(66\)/,
    );
    await runLinuxShell('printf 503 > "$1/$2/releases/$3/.health"\n', [
      root,
      metadata.projectId,
      idB,
    ]);
    const activeRestored = await runLinuxShell(
      `PATH="\${14}/bin:$PATH" FIXTURE_BASE="\${14}/${metadata.projectId}"\nexport PATH FIXTURE_BASE\n${MANUAL_ROLLBACK_REMOTE_SCRIPT}`,
      manualArgs('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    );
    assert.match(
      activeRestored.stdout,
      /MANUAL_ROLLBACK_ACTIVE_RESTORED .*deployment=22222222-2222-4222-8222-222222222222 .*attempted=88888888-8888-4888-8888-888888888888/,
    );
    await runLinuxShell('printf 503 > "$1/$2/releases/$3/.health"\n', [
      root,
      metadata.projectId,
      idA,
    ]);
    const rollbackFailed = await runLinuxShell(
      `PATH="\${14}/bin:$PATH" FIXTURE_BASE="\${14}/${metadata.projectId}"\nexport PATH FIXTURE_BASE\n${MANUAL_ROLLBACK_REMOTE_SCRIPT}`,
      manualArgs('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    );
    assert.match(
      rollbackFailed.stdout,
      /MANUAL_ROLLBACK_FAILED .*failureCode=active_restore_failed/,
    );
    await runLinuxShell('printf 200 > "$1/$2/releases/$3/.health"\n', [
      root,
      metadata.projectId,
      idA,
    ]);
    const server = await runLinuxShell(
      [
        'set -eu',
        'root=$1; project=$2',
        'cat > "$root/server.py" <<\'PY\'',
        'from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer',
        'from pathlib import Path',
        'import sys, time',
        'base = Path(sys.argv[1])',
        'class Handler(BaseHTTPRequestHandler):',
        '    def do_GET(self):',
        '        release = (base / "current").resolve()',
        '        delay = release / ".delay"',
        '        if delay.exists(): time.sleep(float(delay.read_text()))',
        '        self.send_response(int((release / ".health").read_text()))',
        '        self.end_headers()',
        '    def log_message(self, *args): pass',
        'server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)',
        'Path(sys.argv[2]).write_text(str(server.server_port))',
        'server.serve_forever()',
        'PY',
        'cat > "$root/promote.sh" <<\'REMOTE\'',
        PROMOTE_REMOTE_SCRIPT,
        'REMOTE',
        'mv "$root/bin/curl" "$root/bin/curl-stub"',
      ].join('\n'),
      [root, metadata.projectId],
    );
    assert.equal(server.stdout, '');
    const promoteReal = (attempt: string) =>
      runLinuxShell(
        [
          'set -eu',
          'root=$1 project=$2 id=$3 sha=$4 attempt=$5',
          'PATH="$root/bin:$PATH"; export PATH',
          'port_file="$root/port-$attempt"; rm -f -- "$port_file"',
          'python3 "$root/server.py" "$root/$project" "$port_file" </dev/null >/dev/null 2>&1 & server_pid=$!',
          'trap \'kill "$server_pid" 2>/dev/null || true; rm -f -- "$port_file"\' EXIT',
          'i=0; while test ! -s "$port_file"; do i=$((i + 1)); test "$i" -lt 30; sleep 0.1; done',
          'health_url="http://127.0.0.1:$(cat "$port_file")/health"',
          'sh "$root/promote.sh" "$project" "$id" "$sha" "$root" 5 "$attempt" "$health_url" 2 100 200',
        ].join('\n'),
        [root, metadata.projectId, idB, shaB, attempt],
      );
    const realUnhealthy = await promoteReal('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    assert.match(realUnhealthy.stdout, /PROMOTION_ROLLED_BACK .*healthStatus=200/);
    await runLinuxShell('printf 0.5 > "$1/$2/releases/$3/.delay"\n', [
      root,
      metadata.projectId,
      idB,
    ]);
    const realTimeout = await promoteReal('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    assert.match(realTimeout.stdout, /PROMOTION_ROLLED_BACK .*healthStatus=200/);
    await runLinuxShell(
      'rm "$1/$2/releases/$3/.delay"; printf 200 > "$1/$2/releases/$3/.health"\n',
      [root, metadata.projectId, idB],
    );
    const realHealthy = await promoteReal('ffffffff-ffff-4fff-8fff-ffffffffffff');
    assert.match(realHealthy.stdout, /PROMOTION_PROMOTED .*healthStatus=200/);
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
