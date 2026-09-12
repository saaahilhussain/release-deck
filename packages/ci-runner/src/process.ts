import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';

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
  run(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult>;
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

function launchName(command: string): string {
  if (process.platform !== 'win32') return command;
  if (command === 'pnpm' || command === 'npm') return `${command}.cmd`;
  return command;
}

function safeEnvironment(cwd: string): NodeJS.ProcessEnv {
  const path = process.env.PATH;
  if (!path) throw new Error('PATH is not configured');
  const temp = join(cwd, '.tmp');
  const env: NodeJS.ProcessEnv = {
    CI: 'true',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: path,
    HOME: cwd,
    TMPDIR: temp,
    npm_config_cache: join(cwd, '.npm-cache'),
    npm_config_userconfig: join(cwd, '.npmrc'),
    npm_config_global: 'false',
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function appendOutput(state: { chunks: Buffer[]; bytes: number; truncated: boolean }, chunk: Buffer, limit: number): void {
  if (state.bytes >= limit) {
    state.truncated = true;
    return;
  }
  const remaining = limit - state.bytes;
  state.chunks.push(chunk.subarray(0, remaining));
  state.bytes += Math.min(chunk.byteLength, remaining);
  if (chunk.byteLength > remaining) state.truncated = true;
}

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const taskkill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    taskkill.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function baseResult(
  command: string,
  args: readonly string[],
  stdout: { chunks: Buffer[]; truncated: boolean },
  stderr: { chunks: Buffer[]; truncated: boolean },
  startedAt: number,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): ProcessResult {
  return {
    command,
    args: [...args],
    exitCode,
    signal,
    stdout: Buffer.concat(stdout.chunks).toString('utf8'),
    stderr: Buffer.concat(stderr.chunks).toString('utf8'),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    durationMs: Date.now() - startedAt,
  };
}

export const defaultProcessRunner: ProcessRunner = {
  run(command, args, options) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const limit = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('process timeout is invalid');
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new TypeError('kill grace period is invalid');
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('output limit is invalid');

    return new Promise<ProcessResult>((resolve, reject) => {
      const startedAt = Date.now();
      const stdout = { chunks: [] as Buffer[], bytes: 0, truncated: false };
      const stderr = { chunks: [] as Buffer[], bytes: 0, truncated: false };
      const child = spawn(launchName(command), [...args], {
        cwd: options.cwd,
        env: safeEnvironment(options.cwd),
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let settled = false;
      let reason: 'timeout' | 'cancelled' | undefined;
      let timer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        options.signal?.removeEventListener('abort', cancel);
        const result = baseResult(command, args, stdout, stderr, startedAt, child.exitCode, child.signalCode);
        if (error) reject(error);
        else if (reason === 'timeout') reject(new ProcessTimeoutError(result));
        else if (reason === 'cancelled') reject(new ProcessCancelledError(result));
        else resolve(result);
      };
      const terminate = (why: 'timeout' | 'cancelled') => {
        if (settled || reason) return;
        reason = why;
        sendSignal(child, 'SIGTERM');
        graceTimer = setTimeout(() => sendSignal(child, 'SIGKILL'), graceMs);
        graceTimer.unref();
      };
      function cancel() {
        terminate('cancelled');
      }
      child.stdout?.on('data', (chunk: Buffer | string) => appendOutput(stdout, Buffer.from(chunk), limit));
      child.stderr?.on('data', (chunk: Buffer | string) => appendOutput(stderr, Buffer.from(chunk), limit));
      child.once('error', (error) => finish(error));
      child.once('close', () => finish());
      timer = setTimeout(() => terminate('timeout'), timeoutMs);
      timer.unref();
      if (options.signal?.aborted) cancel();
      else options.signal?.addEventListener('abort', cancel, { once: true });
    });
  },
};
