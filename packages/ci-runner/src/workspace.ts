import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface Workspace {
  readonly path: string;
  cleanup(): Promise<void>;
}

export interface WorkspaceManager {
  create(): Promise<Workspace>;
}

export class WorkspaceAllocationCleanupError extends Error {
  readonly allocationError: unknown;
  readonly cleanupError: unknown;

  constructor(allocationError: unknown, cleanupError: unknown) {
    super('failed to clean a partially allocated workspace');
    this.name = 'WorkspaceAllocationCleanupError';
    this.allocationError = allocationError;
    this.cleanupError = cleanupError;
  }
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

async function canonicalRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new TypeError('workspace root must be absolute');
  await mkdir(root, { recursive: true });
  return realpath(root);
}

export function createWorkspaceManager(root: string): WorkspaceManager {
  let rootPromise: Promise<string> | undefined;
  const getRoot = () => (rootPromise ??= canonicalRoot(root));

  return {
    async create() {
      const resolvedRoot = await getRoot();
      const workspace = await mkdtemp(join(resolvedRoot, 'releasedeck-'));
      let resolvedWorkspace: string;
      try {
        resolvedWorkspace = await realpath(workspace);
      } catch (allocationError) {
        try {
          await rm(workspace, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new WorkspaceAllocationCleanupError(allocationError, cleanupError);
        }
        throw allocationError;
      }
      if (!isWithin(resolvedRoot, resolvedWorkspace)) {
        // Remove the lexical allocation entry, never the canonical path it may
        // have been swapped to reference outside the workspace root.
        await rm(workspace, { recursive: true, force: true });
        throw new Error('allocated workspace escaped its root');
      }

      let cleaned = false;
      let cleanupPromise: Promise<void> | undefined;
      return {
        path: resolvedWorkspace,
        async cleanup() {
          if (cleaned) return;
          cleanupPromise ??= (async () => {
            const currentRoot = await getRoot();
            const currentWorkspace = await realpath(resolvedWorkspace).catch(
              () => resolvedWorkspace,
            );
            if (
              !isWithin(currentRoot, currentWorkspace) ||
              !samePath(currentWorkspace, resolvedWorkspace)
            ) {
              throw new Error(
                'refusing to clean workspace outside its original allocation',
              );
            }
            await rm(currentWorkspace, {
              recursive: true,
              force: true,
              maxRetries: 3,
              retryDelay: 100,
            });
            cleaned = true;
          })().catch((error: unknown) => {
            cleanupPromise = undefined;
            throw error;
          });
          await cleanupPromise;
        },
      } satisfies Workspace;
    },
  };
}

export function workspacePath(root: string, child: string): string {
  if (!isAbsolute(root) || !isAbsolute(child))
    throw new TypeError('workspace paths must be absolute');
  const resolved = relative(root, child);
  if (!isWithin(root, child)) throw new Error('path is outside workspace root');
  return join(root, resolved);
}
