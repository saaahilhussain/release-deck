import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const RELEASEDECK_MANIFEST = '.releasedeck.json';
export const MAX_APPLICATION_ROOT_BYTES = 512;

export type ReleaseBuildMode = 'required' | 'none';

export interface ReleaseDeckBuildPlan {
  readonly applicationRoot: string;
  readonly build: ReleaseBuildMode;
}

export const DEFAULT_RELEASEDECK_BUILD_PLAN: ReleaseDeckBuildPlan = Object.freeze({
  applicationRoot: '.',
  build: 'required',
});

export class ReleaseDeckConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReleaseDeckConfigurationError';
  }
}

function fail(message: string, cause?: unknown): never {
  throw new ReleaseDeckConfigurationError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function validateApplicationRoot(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !isWellFormedUnicode(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_APPLICATION_ROOT_BYTES ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    }) ||
    value.includes('\\') ||
    value.startsWith('/') ||
    isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    fail('application root is invalid');
  }
  if (value === '.') return value;
  const components = value.split('/');
  if (
    components.some(
      (component) => component.length === 0 || component === '.' || component === '..',
    )
  ) {
    fail('application root is invalid');
  }
  return value;
}

export function validateReleaseDeckBuildPlan(input: {
  readonly applicationRoot?: unknown;
  readonly build?: unknown;
}): ReleaseDeckBuildPlan {
  const applicationRoot = validateApplicationRoot(
    input.applicationRoot === undefined ? '.' : input.applicationRoot,
  );
  const build = input.build === undefined ? 'required' : input.build;
  if (build !== 'required' && build !== 'none') {
    fail('build mode is invalid');
  }
  return { applicationRoot, build };
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === '' ||
    (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** Validate every repository-controlled path component without following links. */
export async function resolveApplicationRoot(
  workspacePath: string,
  applicationRootInput: unknown,
): Promise<string> {
  const applicationRoot = validateApplicationRoot(applicationRootInput);
  const workspace = resolve(workspacePath);
  try {
    const workspaceInfo = await lstat(workspace);
    if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
      fail('workspace is invalid');
    }
    const canonicalWorkspace = await realpath(workspace);
    if (!samePath(canonicalWorkspace, workspace)) fail('workspace is invalid');

    let candidate = workspace;
    if (applicationRoot !== '.') {
      for (const component of applicationRoot.split('/')) {
        candidate = resolve(candidate, component);
        if (!isWithinOrEqual(workspace, candidate)) {
          fail('application root escapes the workspace');
        }
        const info = await lstat(candidate);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          fail('application root contains an invalid path component');
        }
      }
    }
    const canonicalCandidate = await realpath(candidate);
    if (
      !samePath(canonicalCandidate, candidate) ||
      !isWithinOrEqual(canonicalWorkspace, canonicalCandidate)
    ) {
      fail('application root escapes the workspace');
    }
    return canonicalCandidate;
  } catch (error) {
    if (error instanceof ReleaseDeckConfigurationError) throw error;
    fail('application root is unavailable', error);
  }
}

export async function readReleaseDeckBuildPlan(
  workspacePath: string,
): Promise<ReleaseDeckBuildPlan> {
  const workspace = resolve(workspacePath);
  const manifestPath = resolve(workspace, RELEASEDECK_MANIFEST);
  let info;
  try {
    info = await lstat(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await resolveApplicationRoot(workspace, '.');
      return { ...DEFAULT_RELEASEDECK_BUILD_PLAN };
    }
    fail('ReleaseDeck manifest is unavailable', error);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) {
    fail('ReleaseDeck manifest is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    fail('ReleaseDeck manifest is invalid', error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('ReleaseDeck manifest is invalid');
  }
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'applicationRoot', 'build']);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    !Number.isInteger(record.schemaVersion) ||
    record.schemaVersion !== 1
  ) {
    fail('ReleaseDeck manifest schema is invalid');
  }
  const plan = validateReleaseDeckBuildPlan({
    applicationRoot: record.applicationRoot,
    build: record.build,
  });
  await resolveApplicationRoot(workspace, plan.applicationRoot);
  return plan;
}
