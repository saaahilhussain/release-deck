import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import { ReleaseDeployerError } from './errors.js';
import {
  defaultCommandExecutor,
  type CommandExecutor,
  type CommandResult,
} from './process.js';
import { ACTIVATE_REMOTE_SCRIPT, STAGE_REMOTE_SCRIPT } from './scripts.js';

export interface ReleaseMetadata {
  readonly projectId: string;
  readonly deploymentId: string;
  readonly commitSha: string;
}

export interface PrepareReleaseInput extends ReleaseMetadata {
  readonly workspacePath: string;
  readonly artifactRoot: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
}

export interface PreparedRelease extends ReleaseMetadata {
  readonly archivePath: string;
  readonly metadataPath: string;
  readonly archiveSha256: string;
}

export interface SshTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly privateKeyPath: string;
  readonly knownHostsPath: string;
  readonly remoteRoot: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
}

export interface StageReleaseInput extends ReleaseMetadata {
  readonly attemptId: string;
  readonly artifact: PreparedRelease;
  readonly target: SshTarget;
  readonly signal?: AbortSignal;
}

export interface ActivateReleaseInput extends ReleaseMetadata {
  readonly attemptId: string;
  readonly retention: number;
  readonly target: SshTarget;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface ReleaseProof extends ReleaseMetadata {
  readonly remoteReleasePath: string;
  readonly activeTarget: string;
  readonly pm2ProcessName: string;
  readonly pm2Pid: number;
  readonly nginx: {
    readonly validated: true;
    readonly reloaded: true;
  };
  readonly completedAt: Date;
}

interface StoredArtifactMetadata extends ReleaseMetadata {
  readonly schemaVersion: 1;
  readonly archiveSha256: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;

export function validateReleaseMetadata(input: ReleaseMetadata): ReleaseMetadata {
  if (
    !UUID_PATTERN.test(input.projectId) ||
    !UUID_PATTERN.test(input.deploymentId) ||
    !SHA_PATTERN.test(input.commitSha)
  ) {
    throw new ReleaseDeployerError('preparation', 'release metadata is invalid');
  }
  return {
    projectId: input.projectId.toLowerCase(),
    deploymentId: input.deploymentId.toLowerCase(),
    commitSha: input.commitSha.toLowerCase(),
  };
}

function validateAttemptId(attemptId: string): string {
  if (!UUID_PATTERN.test(attemptId)) {
    throw new ReleaseDeployerError('remote', 'release attempt ID is invalid');
  }
  return attemptId.toLowerCase();
}

export function validateRemoteRoot(value: string): string {
  if (
    value === '/' ||
    !value.startsWith('/') ||
    posix.normalize(value) !== value ||
    !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value) ||
    value.split('/').includes('..')
  ) {
    throw new ReleaseDeployerError('remote', 'remote release root is invalid');
  }
  return value;
}

function validateLocalRoot(value: string, label: string): string {
  if (!isAbsolute(value)) {
    throw new ReleaseDeployerError('preparation', `${label} must be absolute`);
  }
  return resolve(value);
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child !== '' &&
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolveHash);
  });
  return hash.digest('hex');
}

function exactMetadata(
  value: unknown,
  expected: ReleaseMetadata,
): value is StoredArtifactMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify([
      'archiveSha256',
      'commitSha',
      'deploymentId',
      'projectId',
      'schemaVersion',
    ])
  ) {
    return false;
  }
  const metadata = value as Partial<StoredArtifactMetadata>;
  return (
    metadata.schemaVersion === 1 &&
    metadata.projectId === expected.projectId &&
    metadata.deploymentId === expected.deploymentId &&
    metadata.commitSha === expected.commitSha &&
    typeof metadata.archiveSha256 === 'string' &&
    SHA256_PATTERN.test(metadata.archiveSha256)
  );
}

export async function openPreparedRelease(
  artifactRoot: string,
  expectedInput: ReleaseMetadata,
): Promise<PreparedRelease> {
  const expected = validateReleaseMetadata(expectedInput);
  const root = validateLocalRoot(artifactRoot, 'artifact root');
  const directory = join(root, expected.deploymentId);
  const archivePath = join(directory, 'release.tar.gz');
  const metadataPath = join(directory, 'metadata.json');
  try {
    const [directoryInfo, archiveInfo, metadataInfo, metadataText] = await Promise.all([
      lstat(directory),
      lstat(archivePath),
      lstat(metadataPath),
      readFile(metadataPath, 'utf8'),
    ]);
    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      !archiveInfo.isFile() ||
      archiveInfo.isSymbolicLink() ||
      !metadataInfo.isFile() ||
      metadataInfo.isSymbolicLink()
    ) {
      throw new Error('prepared artifact type mismatch');
    }
    const metadata: unknown = JSON.parse(metadataText);
    if (!exactMetadata(metadata, expected)) {
      throw new Error('prepared artifact metadata mismatch');
    }
    const archiveSha256 = await hashFile(archivePath);
    if (archiveSha256 !== metadata.archiveSha256) {
      throw new Error('prepared artifact digest mismatch');
    }
    return { ...expected, archivePath, metadataPath, archiveSha256 };
  } catch (cause) {
    throw new ReleaseDeployerError(
      'preparation',
      'prepared release artifact is unavailable',
      { cause },
    );
  }
}

export async function prepareRelease(
  input: PrepareReleaseInput,
  executor: CommandExecutor = defaultCommandExecutor,
): Promise<PreparedRelease> {
  const metadata = validateReleaseMetadata(input);
  const workspacePath = validateLocalRoot(input.workspacePath, 'workspace path');
  const artifactRoot = validateLocalRoot(input.artifactRoot, 'artifact root');
  if (isWithin(workspacePath, artifactRoot) || samePath(workspacePath, artifactRoot)) {
    throw new ReleaseDeployerError(
      'preparation',
      'artifact root cannot be inside the CI workspace',
    );
  }
  if (
    !(await stat(workspacePath)
      .then((value) => value.isDirectory())
      .catch(() => false))
  ) {
    throw new ReleaseDeployerError('preparation', 'CI workspace is unavailable');
  }
  if (
    !(await lstat(join(workspacePath, 'ecosystem.config.cjs'))
      .then((value) => value.isFile() && !value.isSymbolicLink())
      .catch(() => false))
  ) {
    throw new ReleaseDeployerError('preparation', 'ecosystem.config.cjs is required');
  }
  await mkdir(artifactRoot, { recursive: true });
  const finalDirectory = join(artifactRoot, metadata.deploymentId);
  try {
    return await openPreparedRelease(artifactRoot, metadata);
  } catch {
    if (
      await lstat(finalDirectory)
        .then(() => true)
        .catch(() => false)
    ) {
      throw new ReleaseDeployerError(
        'preparation',
        'an incompatible prepared artifact already exists',
      );
    }
  }

  const temporaryDirectory = await mkdtemp(
    join(artifactRoot, `.prepare-${metadata.deploymentId}-`),
  );
  const embeddedMetadata = join(temporaryDirectory, '.releasedeck-release');
  const archivePath = join(temporaryDirectory, 'release.tar.gz');
  const metadataPath = join(temporaryDirectory, 'metadata.json');
  try {
    await mkdir(embeddedMetadata);
    await Promise.all([
      writeFile(join(embeddedMetadata, 'project-id'), metadata.projectId, 'utf8'),
      writeFile(join(embeddedMetadata, 'deployment-id'), metadata.deploymentId, 'utf8'),
      writeFile(join(embeddedMetadata, 'commit-sha'), metadata.commitSha, 'utf8'),
    ]);
    const result = await executor.run(
      'tar',
      [
        '-czf',
        archivePath,
        '--exclude=.git',
        '--exclude=.env',
        '--exclude=.releasedeck-release',
        '--exclude=.ci',
        '--exclude=.cache',
        '--exclude=.tmp',
        '--exclude=.npm-cache',
        '--exclude=.corepack-cache',
        '--exclude=node_modules/.cache',
        '-C',
        workspacePath,
        '.',
        '-C',
        temporaryDirectory,
        '.releasedeck-release',
      ],
      {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        outputLimitBytes: input.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
      },
    );
    if (result.exitCode !== 0) {
      throw new ReleaseDeployerError('preparation', 'release archive creation failed', {
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(result.signal === null ? {} : { signal: result.signal }),
      });
    }
    const archiveSha256 = await hashFile(archivePath);
    await writeFile(
      metadataPath,
      `${JSON.stringify({
        schemaVersion: 1,
        ...metadata,
        archiveSha256,
      } satisfies StoredArtifactMetadata)}\n`,
      'utf8',
    );
    try {
      await rename(temporaryDirectory, finalDirectory);
    } catch (cause) {
      try {
        return await openPreparedRelease(artifactRoot, metadata);
      } catch {
        throw new ReleaseDeployerError(
          'preparation',
          'prepared artifact could not be published',
          { cause },
        );
      }
    }
    return {
      ...metadata,
      archivePath: join(finalDirectory, 'release.tar.gz'),
      metadataPath: join(finalDirectory, 'metadata.json'),
      archiveSha256,
    };
  } catch (cause) {
    if (cause instanceof ReleaseDeployerError) throw cause;
    throw new ReleaseDeployerError('preparation', 'release preparation failed', {
      cause,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

function validateSshTarget(target: SshTarget): SshTarget {
  const host = target.host.trim();
  if (!(isIP(host) > 0 || HOSTNAME_PATTERN.test(host))) {
    throw new ReleaseDeployerError('transport', 'SSH host is invalid');
  }
  if (!USER_PATTERN.test(target.user)) {
    throw new ReleaseDeployerError('transport', 'SSH user is invalid');
  }
  if (
    !Number.isSafeInteger(target.port) ||
    target.port < 1 ||
    target.port > 65_535 ||
    !Number.isSafeInteger(target.timeoutMs) ||
    target.timeoutMs < 1_000 ||
    target.timeoutMs > 86_400_000 ||
    !Number.isSafeInteger(target.outputLimitBytes) ||
    target.outputLimitBytes < 1_024 ||
    target.outputLimitBytes > 1_048_576 ||
    !isAbsolute(target.privateKeyPath) ||
    !isAbsolute(target.knownHostsPath)
  ) {
    throw new ReleaseDeployerError('transport', 'SSH configuration is invalid');
  }
  return { ...target, host, remoteRoot: validateRemoteRoot(target.remoteRoot) };
}

function destination(target: SshTarget): string {
  const host = isIP(target.host) === 6 ? `[${target.host}]` : target.host;
  return `${target.user}@${host}`;
}

function nullConfigPath(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

function commonSshArgs(targetInput: SshTarget): readonly string[] {
  const target = validateSshTarget(targetInput);
  return [
    '-F',
    nullConfigPath(),
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${target.knownHostsPath}`,
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    `ConnectTimeout=${Math.max(1, Math.ceil(target.timeoutMs / 1_000))}`,
    '-i',
    target.privateKeyPath,
  ];
}

export function buildSshArgs(
  targetInput: SshTarget,
  remoteCommand: string,
): readonly string[] {
  const target = validateSshTarget(targetInput);
  if (!remoteCommand || /[\r\n\0]/.test(remoteCommand)) {
    throw new ReleaseDeployerError('transport', 'remote command is invalid');
  }
  return [
    ...commonSshArgs(target),
    '-p',
    String(target.port),
    destination(target),
    remoteCommand,
  ];
}

export function buildScpArgs(
  targetInput: SshTarget,
  localPath: string,
  remotePath: string,
): readonly string[] {
  const target = validateSshTarget(targetInput);
  if (
    !isAbsolute(localPath) ||
    !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(remotePath) ||
    remotePath.split('/').includes('..')
  ) {
    throw new ReleaseDeployerError('transport', 'SCP path is invalid');
  }
  return [
    '-B',
    ...commonSshArgs(target),
    '-P',
    String(target.port),
    localPath,
    `${destination(target)}:${remotePath}`,
  ];
}

function commandOptions(target: SshTarget, signal: AbortSignal | undefined) {
  return {
    ...(signal === undefined ? {} : { signal }),
    timeoutMs: target.timeoutMs,
    outputLimitBytes: target.outputLimitBytes,
  };
}

function requireSuccess(
  kind: 'transport' | 'remote',
  message: string,
  result: CommandResult,
): void {
  if (result.exitCode === 0 && result.signal === null) return;
  throw new ReleaseDeployerError(kind, message, {
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    ...(result.signal === null ? {} : { signal: result.signal }),
  });
}

function assertArtifactMatches(
  artifact: PreparedRelease,
  metadata: ReleaseMetadata,
): void {
  if (
    artifact.projectId !== metadata.projectId ||
    artifact.deploymentId !== metadata.deploymentId ||
    artifact.commitSha !== metadata.commitSha ||
    !SHA256_PATTERN.test(artifact.archiveSha256) ||
    !isAbsolute(artifact.archivePath)
  ) {
    throw new ReleaseDeployerError(
      'preparation',
      'prepared artifact identity is invalid',
    );
  }
}

function remoteCommand(args: readonly string[]): string {
  if (args.some((value) => !/^[A-Za-z0-9._/-]+$/.test(value))) {
    throw new ReleaseDeployerError('remote', 'remote command argument is invalid');
  }
  return `sh -s -- ${args.join(' ')}`;
}

export async function stageRelease(
  input: StageReleaseInput,
  executor: CommandExecutor = defaultCommandExecutor,
): Promise<void> {
  const metadata = validateReleaseMetadata(input);
  const attemptId = validateAttemptId(input.attemptId);
  const target = validateSshTarget(input.target);
  assertArtifactMatches(input.artifact, metadata);
  const remoteArchive = `/tmp/releasedeck-${metadata.deploymentId}-${attemptId}.tar.gz`;
  const upload = await executor.run(
    'scp',
    buildScpArgs(target, input.artifact.archivePath, remoteArchive),
    commandOptions(target, input.signal),
  );
  requireSuccess('transport', 'release artifact upload failed', upload);
  const command = remoteCommand([
    metadata.projectId,
    metadata.deploymentId,
    metadata.commitSha,
    target.remoteRoot,
    remoteArchive,
    input.artifact.archiveSha256,
    attemptId,
  ]);
  const staged = await executor.run('ssh', buildSshArgs(target, command), {
    ...commandOptions(target, input.signal),
    input: STAGE_REMOTE_SCRIPT,
  });
  requireSuccess('remote', 'remote release staging failed', staged);
  const expected = `RELEASE_STAGED project=${metadata.projectId} deployment=${metadata.deploymentId} sha=${metadata.commitSha} path=${target.remoteRoot}/${metadata.projectId}/releases/${metadata.deploymentId}`;
  if (!staged.stdout.split(/\r?\n/).includes(expected)) {
    throw new ReleaseDeployerError('remote', 'remote release staging proof mismatch');
  }
}

export function parseReleaseProof(
  output: string,
  expectedInput: ReleaseMetadata,
  remoteRoot: string,
  now: () => Date = () => new Date(),
): ReleaseProof {
  const expected = validateReleaseMetadata(expectedInput);
  const root = validateRemoteRoot(remoteRoot);
  const lines = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('RELEASE_PROOF '));
  if (lines.length !== 1) {
    throw new ReleaseDeployerError('remote', 'release proof is missing or ambiguous');
  }
  const entries: [string, string][] = lines[0]!
    .slice('RELEASE_PROOF '.length)
    .split(' ')
    .map((entry): [string, string] => {
      const separator = entry.indexOf('=');
      return separator < 1
        ? ['', '']
        : [entry.slice(0, separator), entry.slice(separator + 1)];
    });
  const fields = new Map(entries);
  const expectedKeys = [
    'active',
    'deployment',
    'nginxReloaded',
    'nginxValidated',
    'path',
    'pid',
    'pm2',
    'project',
    'sha',
  ].sort();
  if (
    fields.size !== expectedKeys.length ||
    JSON.stringify([...fields.keys()].sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new ReleaseDeployerError('remote', 'release proof fields are invalid');
  }
  const releasePath = `${root}/${expected.projectId}/releases/${expected.deploymentId}`;
  const processName = `releasedeck-${expected.projectId}`;
  const pid = fields.get('pid') ?? '';
  if (
    fields.get('project') !== expected.projectId ||
    fields.get('deployment') !== expected.deploymentId ||
    fields.get('sha') !== expected.commitSha ||
    fields.get('path') !== releasePath ||
    fields.get('active') !== releasePath ||
    fields.get('pm2') !== processName ||
    !/^\d+$/.test(pid) ||
    Number(pid) < 1 ||
    !Number.isSafeInteger(Number(pid)) ||
    fields.get('nginxValidated') !== '1' ||
    fields.get('nginxReloaded') !== '1'
  ) {
    throw new ReleaseDeployerError('remote', 'release proof does not match');
  }
  const completedAt = now();
  if (!(completedAt instanceof Date) || Number.isNaN(completedAt.valueOf())) {
    throw new ReleaseDeployerError('remote', 'release proof timestamp is invalid');
  }
  return {
    ...expected,
    remoteReleasePath: releasePath,
    activeTarget: releasePath,
    pm2ProcessName: processName,
    pm2Pid: Number(pid),
    nginx: { validated: true, reloaded: true },
    completedAt,
  };
}

export async function activateRelease(
  input: ActivateReleaseInput,
  executor: CommandExecutor = defaultCommandExecutor,
): Promise<ReleaseProof> {
  const metadata = validateReleaseMetadata(input);
  const attemptId = validateAttemptId(input.attemptId);
  const target = validateSshTarget(input.target);
  if (
    !Number.isSafeInteger(input.retention) ||
    input.retention < 2 ||
    input.retention > 20
  ) {
    throw new ReleaseDeployerError('remote', 'release retention is invalid');
  }
  const command = remoteCommand([
    metadata.projectId,
    metadata.deploymentId,
    metadata.commitSha,
    target.remoteRoot,
    String(input.retention),
    attemptId,
  ]);
  const activated = await executor.run('ssh', buildSshArgs(target, command), {
    ...commandOptions(target, input.signal),
    input: ACTIVATE_REMOTE_SCRIPT,
  });
  requireSuccess('remote', 'remote release activation failed', activated);
  return parseReleaseProof(activated.stdout, metadata, target.remoteRoot, input.now);
}

export async function cleanupPreparedRelease(
  artifactRoot: string,
  deploymentId: string,
): Promise<void> {
  const root = validateLocalRoot(artifactRoot, 'artifact root');
  if (!UUID_PATTERN.test(deploymentId)) {
    throw new ReleaseDeployerError('cleanup', 'deployment ID is invalid');
  }
  const target = join(root, deploymentId.toLowerCase());
  if (!isWithin(root, target)) {
    throw new ReleaseDeployerError('cleanup', 'artifact cleanup target is invalid');
  }
  const targetInfo = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!targetInfo) return;
  try {
    if (targetInfo.isSymbolicLink()) {
      await rm(target, { force: true });
      return;
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(root),
      realpath(target),
    ]);
    if (
      !isWithin(canonicalRoot, canonicalTarget) ||
      !samePath(canonicalTarget, target)
    ) {
      throw new Error('artifact path escaped its root');
    }
    await rm(canonicalTarget, { recursive: true, force: true });
  } catch (cause) {
    throw new ReleaseDeployerError('cleanup', 'artifact cleanup failed', { cause });
  }
}

export function defaultArtifactRoot(): string {
  return resolve(tmpdir(), 'releasedeck-artifacts');
}
