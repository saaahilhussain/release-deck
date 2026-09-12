import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

export interface Workspace {
  readonly path: string;
  cleanup(): Promise<void>;
}

export interface WorkspaceManager {
  create(): Promise<Workspace>;
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
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
      const resolvedWorkspace = await realpath(workspace);
      if (!isWithin(resolvedRoot, resolvedWorkspace)) {
        await rm(resolvedWorkspace, { recursive: true, force: true });
        throw new Error('allocated workspace escaped its root');
      }

      let cleaned = false;
      return {
        path: resolvedWorkspace,
        async cleanup() {
          if (cleaned) return;
          cleaned = true;
          const currentRoot = await getRoot();
          const currentWorkspace = await realpath(resolvedWorkspace).catch(() => resolvedWorkspace);
          if (!isWithin(currentRoot, currentWorkspace)) {
            throw new Error('refusing to clean workspace outside its root');
          }
          await rm(currentWorkspace, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
        },
      } satisfies Workspace;
    },
  };
}

export function workspacePath(root: string, child: string): string {
  if (!isAbsolute(root) || !isAbsolute(child)) throw new TypeError('workspace paths must be absolute');
  const resolved = relative(root, child);
  if (!isWithin(root, child)) throw new Error('path is outside workspace root');
  return join(root, resolved);
}
