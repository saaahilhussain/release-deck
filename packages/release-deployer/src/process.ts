import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';

import { ReleaseDeployerError } from './errors.js';

export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly killGraceMs?: number;
}

export interface CommandExecutor {
  run(
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult>;
}

const DEFAULT_KILL_GRACE_MS = 5_000;
const FORCE_SETTLE_GRACE_MS = 1_000;
const TREE_KILL_COMMAND_TIMEOUT_MS = 5_000;
const TREE_EXIT_POLL_MS = 10;

function safeEnvironment(cwd: string | undefined): NodeJS.ProcessEnv {
  const path = process.env.PATH;
  if (!path) throw new ReleaseDeployerError('transport', 'PATH is not configured');
  const environment: NodeJS.ProcessEnv = { PATH: path };
  for (const key of ['SystemRoot', 'WINDIR', 'PATHEXT', 'ComSpec', 'SYSTEMDRIVE']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  if (process.platform === 'win32' && process.env.ProgramData !== undefined) {
    environment.ProgramData = process.env.ProgramData;
  }
  if (cwd) {
    environment.HOME = cwd;
    environment.TEMP = cwd;
    environment.TMP = cwd;
    environment.TMPDIR = cwd;
  }
  return environment;
}

function appendOutput(
  state: { chunks: Buffer[]; bytes: number; truncated: boolean },
  chunk: Buffer,
  limit: number,
): void {
  if (state.bytes >= limit) {
    state.truncated = true;
    return;
  }
  const remaining = limit - state.bytes;
  state.chunks.push(chunk.subarray(0, remaining));
  state.bytes += Math.min(chunk.byteLength, remaining);
  if (chunk.byteLength > remaining) state.truncated = true;
}

function boundedUtf8(chunks: readonly Buffer[], limit: number): string {
  const bytes = Buffer.concat(chunks).subarray(0, limit);
  let text = bytes.toString('utf8');
  while (Buffer.byteLength(text, 'utf8') > limit) text = text.slice(0, -1);
  return text;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processTreeIsRunning(child: ChildProcess): boolean {
  if (!child.pid) return false;
  if (process.platform === 'win32') return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessTreeExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processTreeIsRunning(child)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(TREE_EXIT_POLL_MS, remaining));
  }
  return true;
}

function fallbackSignal(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (!child) return;
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the liveness check and signal delivery.
  }
}

async function sendTreeSignal(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
    } catch {
      fallbackSignal(child, signal);
    }
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let helper: ChildProcess | undefined;
    const finish = (fallback: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fallback) fallbackSignal(child, signal);
      resolve();
    };
    const timer = setTimeout(() => {
      fallbackSignal(helper, 'SIGKILL');
      finish(true);
    }, TREE_KILL_COMMAND_TIMEOUT_MS);
    timer.unref();
    try {
      helper = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        env: safeEnvironment(dirname(process.execPath)),
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      helper.once('error', () => finish(true));
      helper.once('close', (exitCode) => finish(exitCode !== 0));
    } catch {
      finish(true);
    }
  });
}

function resultFor(
  command: string,
  args: readonly string[],
  child: ChildProcess,
  stdout: { chunks: Buffer[]; truncated: boolean },
  stderr: { chunks: Buffer[]; truncated: boolean },
  outputLimitBytes: number,
  startedAt: number,
): CommandResult {
  return {
    command,
    args: [...args],
    exitCode: child.exitCode,
    signal: child.signalCode,
    stdout: boundedUtf8(stdout.chunks, outputLimitBytes),
    stderr: boundedUtf8(stderr.chunks, outputLimitBytes),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    durationMs: Date.now() - startedAt,
  };
}

export const defaultCommandExecutor: CommandExecutor = {
  run(command, args, options) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new TypeError('command timeout is invalid');
    }
    if (
      !Number.isSafeInteger(options.outputLimitBytes) ||
      options.outputLimitBytes < 1
    ) {
      throw new TypeError('command output limit is invalid');
    }
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0) {
      throw new TypeError('command kill grace is invalid');
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new ReleaseDeployerError('transport', 'release command was cancelled'),
      );
    }

    return new Promise<CommandResult>((resolve, reject) => {
      const startedAt = Date.now();
      const stdout = { chunks: [] as Buffer[], bytes: 0, truncated: false };
      const stderr = { chunks: [] as Buffer[], bytes: 0, truncated: false };
      let child: ChildProcess;
      try {
        child = spawn(command, [...args], {
          cwd: options.cwd,
          detached: process.platform !== 'win32',
          env: safeEnvironment(options.cwd),
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (cause) {
        reject(
          new ReleaseDeployerError('transport', 'release command could not start', {
            cause,
          }),
        );
        return;
      }

      let settled = false;
      let reason: 'timeout' | 'cancelled' | undefined;
      const finish = (cause?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        const result = resultFor(
          command,
          args,
          child,
          stdout,
          stderr,
          options.outputLimitBytes,
          startedAt,
        );
        if (cause) {
          reject(
            new ReleaseDeployerError('transport', 'release command could not start', {
              cause,
            }),
          );
        } else if (reason) {
          reject(
            new ReleaseDeployerError(
              'transport',
              reason === 'timeout'
                ? 'release command timed out'
                : 'release command was cancelled',
              {
                ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
                ...(result.signal === null ? {} : { signal: result.signal }),
              },
            ),
          );
        } else {
          resolve(result);
        }
      };
      const terminate = (why: 'timeout' | 'cancelled') => {
        if (settled || reason) return;
        reason = why;
        void (async () => {
          await sendTreeSignal(child, 'SIGTERM');
          if (process.platform !== 'win32') {
            if (!(await waitForProcessTreeExit(child, killGraceMs))) {
              await sendTreeSignal(child, 'SIGKILL');
              await waitForProcessTreeExit(child, FORCE_SETTLE_GRACE_MS);
            }
          }
          finish();
        })();
      };
      function cancel() {
        terminate('cancelled');
      }

      child.stdout?.on('data', (chunk: Buffer | string) =>
        appendOutput(stdout, Buffer.from(chunk), options.outputLimitBytes),
      );
      child.stderr?.on('data', (chunk: Buffer | string) =>
        appendOutput(stderr, Buffer.from(chunk), options.outputLimitBytes),
      );
      child.once('error', (cause) => finish(cause));
      child.once('close', () => {
        if (!reason) finish();
      });
      if (options.input === undefined) child.stdin?.end();
      else child.stdin?.end(options.input, 'utf8');

      const timer = setTimeout(() => terminate('timeout'), options.timeoutMs);
      timer.unref();
      if (options.signal?.aborted) cancel();
      else options.signal?.addEventListener('abort', cancel, { once: true });
    });
  },
};
