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
import {
  ACTIVATE_REMOTE_SCRIPT,
  MANUAL_ROLLBACK_REMOTE_SCRIPT,
  PROMOTE_REMOTE_SCRIPT,
  STAGE_REMOTE_SCRIPT,
} from './scripts.js';

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
  readonly healthUrl: string;
  readonly healthAttempts: number;
  readonly healthIntervalMs: number;
  readonly healthRequestTimeoutMs: number;
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

export interface PromoteReleaseInput extends ReleaseMetadata {
  readonly attemptId: string;
  readonly retention: number;
  readonly target: SshTarget;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export type PromotionOutcome =
  | {
      readonly status: 'PROMOTED';
      readonly proof: ReleaseProof;
      readonly healthProof: ReleaseHealthProof;
    }
  | {
      readonly status: 'ROLLED_BACK';
      readonly candidate: ReleaseMetadata;
      readonly restored: ReleaseMetadata & {
        readonly releaseId: string;
        readonly remoteReleasePath: string;
        readonly activeTarget: string;
      };
      readonly healthProof: ReleaseHealthProof;
    }
  | {
      readonly status: 'ROLLBACK_FAILED';
      readonly candidate: ReleaseMetadata;
      readonly attemptedRestore: ReleaseMetadata;
      readonly failureCode:
        'candidate_unhealthy' | 'restore_unhealthy' | 'activation_failed';
    }
  | {
      readonly status: 'NO_KNOWN_GOOD';
      readonly candidate: ReleaseMetadata;
      readonly failureCode: 'no_known_good';
    };

export interface ReleaseHealthProof {
  readonly url: string;
  readonly statusCode: number;
  readonly attempts: number;
  readonly completedAt: Date;
}

export interface ManualRollbackInput extends ReleaseMetadata {
  readonly targetDeploymentId: string;
  readonly targetCommitSha: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly retention: number;
  readonly target: SshTarget;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export type RollbackOutcome =
  | {
      readonly status: 'RESTORED';
      readonly proof: ReleaseProof;
      readonly healthProof: ReleaseHealthProof;
    }
  | {
      readonly status: 'FAILED_ACTIVE_RESTORED';
      readonly active: ReleaseMetadata;
      readonly attemptedRestore: ReleaseMetadata;
      readonly proof: ReleaseProof;
      readonly healthProof: ReleaseHealthProof;
    }
  | {
      readonly status: 'ROLLBACK_FAILED';
      readonly active: ReleaseMetadata;
      readonly attemptedRestore: ReleaseMetadata;
      readonly failureCode: 'restore_unhealthy' | 'active_restore_failed';
    };

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
  let health: URL;
  try {
    health = new URL(target.healthUrl);
  } catch {
    throw new ReleaseDeployerError(
      'transport',
      'health check configuration is invalid',
    );
  }
  const healthBudgetMs =
    target.healthAttempts * target.healthRequestTimeoutMs +
    (target.healthAttempts - 1) * target.healthIntervalMs;
  if (healthBudgetMs * 2 >= target.timeoutMs) {
    throw new ReleaseDeployerError(
      'transport',
      'health checks exceed the remote deadline',
    );
  }
  if (
    health.protocol !== 'http:' ||
    health.hostname !== '127.0.0.1' ||
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}(?:\/[A-Za-z0-9._~/-]*)?$/.test(
      target.healthUrl,
    ) ||
    Number(health.port) < 1 ||
    Number(health.port) > 65_535 ||
    health.username !== '' ||
    health.password !== '' ||
    health.search !== '' ||
    health.hash !== '' ||
    !Number.isSafeInteger(target.healthAttempts) ||
    target.healthAttempts < 1 ||
    target.healthAttempts > 20 ||
    !Number.isSafeInteger(target.healthIntervalMs) ||
    target.healthIntervalMs < 100 ||
    target.healthIntervalMs > 10_000 ||
    !Number.isSafeInteger(target.healthRequestTimeoutMs) ||
    target.healthRequestTimeoutMs < 100 ||
    target.healthRequestTimeoutMs > 10_000
  ) {
    throw new ReleaseDeployerError(
      'transport',
      'health check configuration is invalid',
    );
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
  if (args.some((value) => !/^[A-Za-z0-9._/:+-]+$/.test(value))) {
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

function parseOutcomeFields(output: string, prefix: string): Map<string, string> {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith(`${prefix} `));
  if (lines.length !== 1) {
    throw new ReleaseDeployerError(
      'remote',
      'remote outcome proof is missing or ambiguous',
    );
  }
  const entries = lines[0]!
    .slice(prefix.length + 1)
    .split(' ')
    .map((item) => {
      const splitAt = item.indexOf('=');
      return (
        splitAt < 1 ? ['', ''] : [item.slice(0, splitAt), item.slice(splitAt + 1)]
      ) as [string, string];
    });
  const fields = new Map(entries);
  if (
    fields.size !== entries.length ||
    [...fields.values()].some((value) => value === '')
  ) {
    throw new ReleaseDeployerError('remote', 'remote outcome proof fields are invalid');
  }
  const expectedKeys: Record<string, readonly string[]> = {
    PROMOTION_PROMOTED: [
      'active',
      'deployment',
      'healthAttempts',
      'healthStatus',
      'nginxReloaded',
      'nginxValidated',
      'path',
      'pid',
      'pm2',
      'project',
      'sha',
    ],
    PROMOTION_ROLLED_BACK: [
      'active',
      'candidate',
      'candidateSha',
      'deployment',
      'healthAttempts',
      'healthStatus',
      'nginxReloaded',
      'nginxValidated',
      'path',
      'pid',
      'pm2',
      'project',
      'sha',
    ],
    PROMOTION_ROLLBACK_FAILED: [
      'candidate',
      'candidateSha',
      'deployment',
      'failureCode',
      'project',
      'sha',
    ],
    PROMOTION_NO_KNOWN_GOOD: [
      'candidate',
      'candidateSha',
      'deployment',
      'failureCode',
      'project',
      'sha',
    ],
    MANUAL_ROLLBACK_RESTORED: [
      'active',
      'deployment',
      'healthAttempts',
      'healthStatus',
      'nginxReloaded',
      'nginxValidated',
      'path',
      'pid',
      'pm2',
      'project',
      'sha',
    ],
    MANUAL_ROLLBACK_ACTIVE_RESTORED: [
      'active',
      'attempted',
      'attemptedSha',
      'deployment',
      'healthAttempts',
      'healthStatus',
      'nginxReloaded',
      'nginxValidated',
      'path',
      'pid',
      'pm2',
      'project',
      'sha',
    ],
    MANUAL_ROLLBACK_FAILED: [
      'attempted',
      'attemptedSha',
      'deployment',
      'failureCode',
      'project',
      'sha',
    ],
  };
  const keys = expectedKeys[prefix];
  if (
    !keys ||
    JSON.stringify([...fields.keys()].sort()) !== JSON.stringify([...keys].sort())
  ) {
    throw new ReleaseDeployerError('remote', 'remote outcome proof fields are invalid');
  }
  return fields;
}

function requireOneOutcome(output: string, prefixes: readonly string[]): string {
  const lines = output.split(/\r?\n/);
  const matches = prefixes.filter((prefix) =>
    lines.some((line) => line.startsWith(`${prefix} `)),
  );
  if (matches.length !== 1) {
    throw new ReleaseDeployerError('remote', 'remote outcome is ambiguous or missing');
  }
  return matches[0]!;
}

function healthProof(
  fields: Map<string, string>,
  target: SshTarget,
  now?: () => Date,
): ReleaseHealthProof {
  const statusCode = Number(fields.get('healthStatus'));
  const attempts = Number(fields.get('healthAttempts'));
  if (
    !Number.isSafeInteger(statusCode) ||
    statusCode < 200 ||
    statusCode >= 300 ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > target.healthAttempts
  )
    throw new ReleaseDeployerError('remote', 'health proof is invalid');
  const completedAt = (now ?? (() => new Date()))();
  if (!(completedAt instanceof Date) || Number.isNaN(completedAt.valueOf())) {
    throw new ReleaseDeployerError('remote', 'health proof timestamp is invalid');
  }
  return { url: target.healthUrl, statusCode, attempts, completedAt };
}

function proofFromFields(
  fields: Map<string, string>,
  expected: ReleaseMetadata,
  target: SshTarget,
  now?: () => Date,
): ReleaseProof {
  return parseReleaseProof(
    `RELEASE_PROOF project=${fields.get('project')} deployment=${fields.get('deployment')} sha=${fields.get('sha')} path=${fields.get('path')} active=${fields.get('active')} pm2=${fields.get('pm2')} pid=${fields.get('pid')} nginxValidated=${fields.get('nginxValidated')} nginxReloaded=${fields.get('nginxReloaded')}`,
    expected,
    target.remoteRoot,
    now,
  );
}

export async function promoteRelease(
  input: PromoteReleaseInput,
  executor: CommandExecutor = defaultCommandExecutor,
): Promise<PromotionOutcome> {
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
    target.healthUrl,
    String(target.healthAttempts),
    String(target.healthIntervalMs),
    String(target.healthRequestTimeoutMs),
  ]);
  const result = await executor.run('ssh', buildSshArgs(target, command), {
    ...commandOptions(target, input.signal),
    input: PROMOTE_REMOTE_SCRIPT,
  });
  requireSuccess('remote', 'remote health-gated promotion failed', result);
  if (result.stdoutTruncated) {
    throw new ReleaseDeployerError('remote', 'remote promotion proof was truncated');
  }
  const prefix = requireOneOutcome(result.stdout, [
    'PROMOTION_PROMOTED',
    'PROMOTION_ROLLED_BACK',
    'PROMOTION_ROLLBACK_FAILED',
    'PROMOTION_NO_KNOWN_GOOD',
  ]);
  const fields = parseOutcomeFields(result.stdout, prefix);
  const releaseIdentity = (idKey: string, shaKey: string): ReleaseMetadata => ({
    projectId: fields.get('project') ?? '',
    deploymentId: fields.get(idKey) ?? '',
    commitSha: fields.get(shaKey) ?? '',
  });
  if (fields.get('project') !== metadata.projectId)
    throw new ReleaseDeployerError('remote', 'promotion project proof mismatch');
  const candidate = releaseIdentity('candidate', 'candidateSha');
  if (prefix === 'PROMOTION_NO_KNOWN_GOOD') {
    if (
      fields.get('deployment') !== metadata.deploymentId ||
      fields.get('sha') !== metadata.commitSha ||
      fields.get('candidate') !== metadata.deploymentId ||
      fields.get('candidateSha') !== metadata.commitSha ||
      fields.get('failureCode') !== 'no_known_good'
    ) {
      throw new ReleaseDeployerError('remote', 'missing known-good proof is invalid');
    }
    return {
      status: 'NO_KNOWN_GOOD',
      candidate: metadata,
      failureCode: 'no_known_good',
    };
  }
  if (prefix === 'PROMOTION_ROLLBACK_FAILED') {
    const failureCode = fields.get('failureCode');
    if (
      fields.get('candidate') !== metadata.deploymentId ||
      fields.get('candidateSha') !== metadata.commitSha ||
      (failureCode !== 'restore_unhealthy' &&
        failureCode !== 'candidate_unhealthy' &&
        failureCode !== 'activation_failed')
    ) {
      throw new ReleaseDeployerError('remote', 'rollback failure proof is invalid');
    }
    const attemptedRestore = validateReleaseMetadata(
      releaseIdentity('deployment', 'sha'),
    );
    if (attemptedRestore.deploymentId === metadata.deploymentId) {
      throw new ReleaseDeployerError('remote', 'rollback target proof is invalid');
    }
    return {
      status: 'ROLLBACK_FAILED',
      candidate: metadata,
      attemptedRestore,
      failureCode,
    };
  }
  const health = healthProof(fields, target, input.now);
  if (prefix === 'PROMOTION_PROMOTED') {
    return {
      status: 'PROMOTED',
      proof: proofFromFields(fields, metadata, target, input.now),
      healthProof: health,
    };
  }
  if (
    candidate.deploymentId !== metadata.deploymentId ||
    candidate.commitSha !== metadata.commitSha
  ) {
    throw new ReleaseDeployerError('remote', 'candidate rollback proof mismatch');
  }
  const restoredProof = proofFromFields(
    fields,
    releaseIdentity('deployment', 'sha'),
    target,
    input.now,
  );
  return {
    status: 'ROLLED_BACK',
    candidate: metadata,
    restored: {
      ...releaseIdentity('deployment', 'sha'),
      releaseId: fields.get('deployment')!,
      remoteReleasePath: restoredProof.remoteReleasePath,
      activeTarget: restoredProof.activeTarget,
    },
    healthProof: health,
  };
}

export async function rollbackRelease(
  input: ManualRollbackInput,
  executor: CommandExecutor = defaultCommandExecutor,
): Promise<RollbackOutcome> {
  const active = validateReleaseMetadata(input);
  const restore = validateReleaseMetadata({
    projectId: input.projectId,
    deploymentId: input.targetDeploymentId,
    commitSha: input.targetCommitSha,
  });
  if (restore.deploymentId === active.deploymentId)
    throw new ReleaseDeployerError(
      'remote',
      'rollback target must differ from active release',
    );
  const attemptId = validateAttemptId(input.attemptId);
  const requestId = validateAttemptId(input.requestId);
  const target = validateSshTarget(input.target);
  if (
    !Number.isSafeInteger(input.retention) ||
    input.retention < 2 ||
    input.retention > 20
  ) {
    throw new ReleaseDeployerError('remote', 'release retention is invalid');
  }
  const command = remoteCommand([
    active.projectId,
    active.deploymentId,
    active.commitSha,
    restore.deploymentId,
    restore.commitSha,
    target.remoteRoot,
    String(input.retention),
    attemptId,
    target.healthUrl,
    String(target.healthAttempts),
    String(target.healthIntervalMs),
    String(target.healthRequestTimeoutMs),
    requestId,
  ]);
  const result = await executor.run('ssh', buildSshArgs(target, command), {
    ...commandOptions(target, input.signal),
    input: MANUAL_ROLLBACK_REMOTE_SCRIPT,
  });
  requireSuccess('remote', 'remote manual rollback failed', result);
  if (result.stdoutTruncated) {
    throw new ReleaseDeployerError('remote', 'remote rollback proof was truncated');
  }
  const prefix = requireOneOutcome(result.stdout, [
    'MANUAL_ROLLBACK_RESTORED',
    'MANUAL_ROLLBACK_ACTIVE_RESTORED',
    'MANUAL_ROLLBACK_FAILED',
  ]);
  const fields = parseOutcomeFields(result.stdout, prefix);
  if (prefix === 'MANUAL_ROLLBACK_FAILED') {
    if (
      fields.get('project') !== active.projectId ||
      fields.get('deployment') !== active.deploymentId ||
      fields.get('sha') !== active.commitSha ||
      fields.get('attempted') !== restore.deploymentId ||
      fields.get('attemptedSha') !== restore.commitSha ||
      fields.get('failureCode') !== 'active_restore_failed'
    ) {
      throw new ReleaseDeployerError(
        'remote',
        'manual rollback failure proof is invalid',
      );
    }
    return {
      status: 'ROLLBACK_FAILED',
      active,
      attemptedRestore: restore,
      failureCode: 'active_restore_failed',
    };
  }
  const expected = prefix === 'MANUAL_ROLLBACK_RESTORED' ? restore : active;
  if (
    fields.get('project') !== active.projectId ||
    (prefix === 'MANUAL_ROLLBACK_ACTIVE_RESTORED' &&
      (fields.get('attempted') !== restore.deploymentId ||
        fields.get('attemptedSha') !== restore.commitSha))
  )
    throw new ReleaseDeployerError('remote', 'manual rollback identity proof mismatch');
  const proof = proofFromFields(fields, expected, target, input.now);
  const health = healthProof(fields, target, input.now);
  return prefix === 'MANUAL_ROLLBACK_RESTORED'
    ? { status: 'RESTORED', proof, healthProof: health }
    : {
        status: 'FAILED_ACTIVE_RESTORED',
        active,
        attemptedRestore: restore,
        proof,
        healthProof: health,
      };
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
