import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export const DEFAULT_OUTPUT_LIMIT_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
export const DEFAULT_KILL_GRACE_MS = 5_000;

export interface ProcessResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

export interface ProcessOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly outputLimitBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult>;
}

export class ProcessTimeoutError extends Error {
  readonly result: ProcessResult;
  constructor(result: ProcessResult) {
    super('child process timed out');
    this.name = 'ProcessTimeoutError';
    this.result = result;
  }
}

export class ProcessCancelledError extends Error {
  readonly result: ProcessResult;
  constructor(result: ProcessResult) {
    super('child process was cancelled');
    this.name = 'ProcessCancelledError';
    this.result = result;
  }
}

const FORCE_SETTLE_GRACE_MS = 1_000;
const TREE_KILL_COMMAND_TIMEOUT_MS = 5_000;
const TREE_EXIT_POLL_MS = 10;

function launch(
  command: string,
  args: readonly string[],
): { command: string; args: readonly string[] } {
  if (process.platform !== 'win32' || (command !== 'pnpm' && command !== 'npm')) {
    return { command, args };
  }
  const scriptName = command === 'npm' ? 'npm-cli.js' : 'pnpm.cjs';
  const candidates = [
    join(dirname(process.execPath), 'node_modules', command, 'bin', scriptName),
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .map((entry) => join(entry, 'node_modules', command, 'bin', scriptName)),
  ];
  const script = candidates.find((candidate) => existsSync(candidate));
  if (!script) throw new Error(`could not locate the fixed ${command} launcher`);
  return { command: process.execPath, args: [script, ...args] };
}

function safeEnvironment(cwd: string): NodeJS.ProcessEnv {
  const path = process.env.PATH;
  if (!path) throw new Error('PATH is not configured');
  const temp = join(cwd, '.tmp');
  mkdirSync(temp, { recursive: true });
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env: NodeJS.ProcessEnv = {
    CI: 'true',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullDevice,
    PATH: path,
    HOME: cwd,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    NPM_CONFIG_CACHE: join(cwd, '.npm-cache'),
    NPM_CONFIG_USERCONFIG: nullDevice,
    NPM_CONFIG_GLOBAL: 'false',
    COREPACK_HOME: join(cwd, '.corepack-cache'),
  };
  for (const key of ['SystemRoot', 'WINDIR', 'PATHEXT', 'ComSpec']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
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

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (!child.pid) return Promise.resolve();
  const fallback = () => {
    try {
      child.kill(signal);
    } catch {
      // The child may have exited between taskkill and the fallback.
    }
  };
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let complete = false;
      let taskkill: ChildProcess | undefined;
      const finish = (useFallback: boolean) => {
        if (complete) return;
        complete = true;
        clearTimeout(commandTimer);
        if (useFallback) fallback();
        resolve();
      };
      const commandTimer = setTimeout(() => {
        try {
          taskkill?.kill('SIGKILL');
        } catch {
          // The taskkill helper may have exited as its timeout fired.
        }
        finish(true);
      }, TREE_KILL_COMMAND_TIMEOUT_MS);
      commandTimer.unref();
      try {
        taskkill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        taskkill.once('error', () => finish(true));
        taskkill.once('close', (exitCode) => finish(exitCode !== 0));
      } catch {
        finish(true);
      }
    });
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    fallback();
  }
  return Promise.resolve();
}

export function boundedUtf8(
  bytes: Buffer,
  limit: number,
): { text: string; truncated: boolean } {
  const clipped = bytes.subarray(0, limit);
  let text = clipped.toString('utf8');
  const encodedBytes = Buffer.byteLength(text, 'utf8');
  if (encodedBytes > limit) {
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= limit) low = middle;
      else high = middle - 1;
    }
    text = text.slice(0, low);
  }
  return { text, truncated: bytes.byteLength > limit || encodedBytes > limit };
}

function baseResult(
  command: string,
  args: readonly string[],
  stdout: { chunks: Buffer[]; truncated: boolean },
  stderr: { chunks: Buffer[]; truncated: boolean },
  startedAt: number,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  limit: number,
): ProcessResult {
  const boundedStdout = boundedUtf8(Buffer.concat(stdout.chunks), limit);
  const boundedStderr = boundedUtf8(Buffer.concat(stderr.chunks), limit);
  return {
    command,
    args: [...args],
    exitCode,
    signal,
    stdout: boundedStdout.text,
    stderr: boundedStderr.text,
    stdoutTruncated: stdout.truncated || boundedStdout.truncated,
    stderrTruncated: stderr.truncated || boundedStderr.truncated,
    durationMs: Date.now() - startedAt,
  };
}

export const defaultProcessRunner: ProcessRunner = {
  run(command, args, options) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const limit = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new TypeError('process timeout is invalid');
    if (!Number.isSafeInteger(graceMs) || graceMs < 0)
      throw new TypeError('kill grace period is invalid');
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new TypeError('output limit is invalid');

    if (options.signal?.aborted) {
      return Promise.reject(
        new ProcessCancelledError({
          command,
          args: [...args],
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 0,
        }),
      );
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const startedAt = Date.now();
      const stdout = { chunks: [] as Buffer[], bytes: 0, truncated: false };
      const stderr = { chunks: [] as Buffer[], bytes: 0, truncated: false };
      const launched = launch(command, args);
      const child = spawn(launched.command, [...launched.args], {
        cwd: options.cwd,
        env: safeEnvironment(options.cwd),
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let settled = false;
      let reason: 'timeout' | 'cancelled' | undefined;
      const timer = setTimeout(() => terminate('timeout'), timeoutMs);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        const result = baseResult(
          command,
          args,
          stdout,
          stderr,
          startedAt,
          child.exitCode,
          child.signalCode,
          limit,
        );
        if (error) reject(error);
        else if (reason === 'timeout') reject(new ProcessTimeoutError(result));
        else if (reason === 'cancelled') reject(new ProcessCancelledError(result));
        else resolve(result);
      };
      const terminate = (why: 'timeout' | 'cancelled') => {
        if (settled || reason) return;
        reason = why;
        void (async () => {
          await sendSignal(child, 'SIGTERM');
          if (process.platform !== 'win32') {
            const terminated = await waitForProcessTreeExit(child, graceMs);
            if (!terminated) {
              await sendSignal(child, 'SIGKILL');
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
        appendOutput(stdout, Buffer.from(chunk), limit),
      );
      child.stderr?.on('data', (chunk: Buffer | string) =>
        appendOutput(stderr, Buffer.from(chunk), limit),
      );
      child.once('error', (error) => finish(error));
      child.once('close', () => {
        if (!reason) finish();
      });
      timer.unref();
      if (options.signal?.aborted) cancel();
      else options.signal?.addEventListener('abort', cancel, { once: true });
    });
  },
};
