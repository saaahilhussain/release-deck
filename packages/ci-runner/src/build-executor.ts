import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { validateApplicationRoot } from '@releasedeck/project-config';

import {
  ProcessCancelledError,
  ProcessTimeoutError,
  type ProcessOptions,
  type ProcessResult,
} from './process.js';

export type BuildStage = 'INSTALL' | 'TEST' | 'BUILD';
export type BuildManager = 'npm' | 'pnpm';

export interface BuildSession {
  readonly workspacePath: string;
  run(
    stage: BuildStage,
    manager: BuildManager,
    workingDirectory: string,
    options: ProcessOptions,
  ): Promise<ProcessResult>;
  /** Advance only the BUILD stage without executing repository code. */
  completeBuild(
    manager: BuildManager,
    workingDirectory: string,
  ): Promise<ProcessResult>;
  /** Stop/verify the boundary and revoke build access before trusted collection. */
  collect(manager: BuildManager, workingDirectory: string): Promise<void>;
  close(): Promise<void>;
}

export interface BuildExecutor {
  probe(): Promise<void>;
  open(workspacePath: string): Promise<BuildSession>;
}

export type LauncherRequest = Readonly<Record<string, string | number>>;
export type LauncherReply = Readonly<Record<string, unknown>>;
export type LauncherTransport = (request: LauncherRequest) => Promise<LauncherReply>;

function commandFor(stage: BuildStage, manager: BuildManager): readonly string[] {
  if (stage === 'INSTALL')
    return manager === 'npm' ? ['ci'] : ['install', '--frozen-lockfile'];
  return stage === 'TEST' ? ['test'] : ['run', 'build'];
}

/** The privileged helper accepts bounded JSON on stdin, never arbitrary argv/env. */
export function createLauncherTransport(launcherPath: string): LauncherTransport {
  if (process.platform !== 'linux' || !isAbsolute(launcherPath)) {
    throw new Error('isolated build execution requires a Linux launcher');
  }
  return (request) =>
    new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sudo', ['-n', '--', launcherPath], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let rejected = false;
      const fail = () => {
        if (!rejected) {
          rejected = true;
          reject(new Error('isolated build launcher unavailable or failed'));
        }
      };
      // RuntimeMaxSec is enforced inside systemd as well. Killing this client alone
      // is never treated as proof that a build/cgroup has stopped.
      const timeout = setTimeout(
        () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* Teardown is confirmed through the launcher. */
          }
          fail();
        },
        (typeof request.timeoutMs === 'number' ? request.timeoutMs : 120_000) + 60_000,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* Teardown is confirmed through the launcher. */
          }
          fail();
        } else chunks.push(chunk);
      });
      child.stderr.resume(); // Never forward sudo/systemd diagnostics into deployment output.
      child.stdin.on('error', fail);
      child.once('error', () => {
        clearTimeout(timeout);
        fail();
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (rejected) return;
        try {
          const reply: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (
            code !== 0 ||
            !reply ||
            typeof reply !== 'object' ||
            Array.isArray(reply) ||
            (reply as LauncherReply).ok !== true
          ) {
            fail();
            return;
          }
          resolve(reply as LauncherReply);
        } catch {
          fail();
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
}

export function createSystemdBuildExecutor(
  launcherPath: string,
  transport: LauncherTransport = createLauncherTransport(launcherPath),
): BuildExecutor {
  let busy = false;
  return {
    async probe() {
      await transport({ op: 'probe' });
    },
    async open(workspacePath) {
      if (busy) throw new Error('isolated build execution permits one job at a time');
      busy = true;
      const jobId = randomUUID();
      let closed = false;
      const close = async () => {
        if (closed) return;
        await transport({ op: 'close', jobId });
        closed = true;
        busy = false; // A failed cleanup deliberately leaves this executor locked.
      };
      try {
        const reply = await transport({ op: 'open', jobId, workspacePath });
        if (
          typeof reply.workspacePath !== 'string' ||
          !isAbsolute(reply.workspacePath)
        ) {
          throw new Error('isolated build workspace response is invalid');
        }
        const buildPath = reply.workspacePath;
        return {
          workspacePath: buildPath,
          close,
          async collect(manager, workingDirectory) {
            await transport({
              op: 'collect',
              jobId,
              manager,
              workingDirectory: validateApplicationRoot(workingDirectory),
            });
          },
          async completeBuild(manager, workingDirectory) {
            const response = await transport({
              op: 'completeBuild',
              jobId,
              stage: 'BUILD',
              manager,
              workingDirectory: validateApplicationRoot(workingDirectory),
            });
            const result = response.result as ProcessResult | undefined;
            if (
              !result ||
              result.command !== 'releasedeck' ||
              JSON.stringify(result.args) !== JSON.stringify(['build', 'none']) ||
              result.exitCode !== 0 ||
              result.signal !== null ||
              !Number.isSafeInteger(result.durationMs) ||
              typeof result.stdout !== 'string' ||
              typeof result.stderr !== 'string' ||
              result.stdoutTruncated !== false ||
              result.stderrTruncated !== false
            ) {
              throw new Error('isolated build completion result is invalid');
            }
            return result;
          },
          async run(stage, manager, workingDirectory, options) {
            const timeoutMs = options.timeoutMs ?? 600_000;
            const outputLimitBytes = options.outputLimitBytes ?? 256 * 1024;
            const args = commandFor(stage, manager);
            let cancelled = options.signal?.aborted ?? false;
            let cancellation: Promise<LauncherReply> | undefined;
            const abort = () => {
              cancelled = true;
              cancellation ??= Promise.resolve().then(() =>
                transport({ op: 'cancel', jobId }),
              );
              // Observe immediately; await again before returning to the caller.
              void cancellation.catch(() => undefined);
            };
            if (cancelled) abort();
            else options.signal?.addEventListener('abort', abort, { once: true });
            try {
              if (cancelled) {
                await cancellation;
                throw new ProcessCancelledError({
                  command: manager,
                  args,
                  exitCode: null,
                  signal: null,
                  stdout: '',
                  stderr: '',
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  durationMs: 0,
                });
              }
              let response: LauncherReply;
              try {
                response = await transport({
                  op: 'run',
                  jobId,
                  stage,
                  manager,
                  workingDirectory: validateApplicationRoot(workingDirectory),
                  timeoutMs,
                  outputLimitBytes,
                });
              } catch (error) {
                await cancellation;
                if (cancelled) {
                  throw new ProcessCancelledError({
                    command: manager,
                    args,
                    exitCode: null,
                    signal: null,
                    stdout: '',
                    stderr: '',
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    durationMs: 0,
                  });
                }
                throw error;
              }
              await cancellation;
              const result = response.result as ProcessResult | undefined;
              if (
                !result ||
                !Number.isSafeInteger(result.durationMs) ||
                !(result.exitCode === null || Number.isSafeInteger(result.exitCode)) ||
                typeof result.stdout !== 'string' ||
                typeof result.stderr !== 'string' ||
                Buffer.byteLength(result.stdout) > outputLimitBytes ||
                Buffer.byteLength(result.stderr) > outputLimitBytes
              ) {
                throw new Error('isolated build result is invalid');
              }
              const safeResult = { ...result, command: manager, args };
              if (cancelled) throw new ProcessCancelledError(safeResult);
              if (response.timedOut === true) throw new ProcessTimeoutError(safeResult);
              return safeResult;
            } finally {
              options.signal?.removeEventListener('abort', abort);
              // Cancellation failure must not be hidden by an ordinary command result.
              await cancellation;
            }
          },
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
