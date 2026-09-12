import { access } from 'node:fs/promises';
import { join } from 'node:path';

import {
  defaultProcessRunner,
  type ProcessResult,
  type ProcessRunner,
  type ProcessOptions,
} from './process.js';
import { createWorkspaceManager, type WorkspaceManager } from './workspace.js';

export const CI_STAGES = ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD'] as const;
export type CiStage = (typeof CI_STAGES)[number];
export type PackageManager = 'pnpm' | 'npm';

export interface CiRunInput {
  readonly deploymentId: string;
  readonly repositoryUrl: string;
  readonly commitSha: string;
  readonly packageManager: PackageManager;
  readonly signal?: AbortSignal;
}

export interface CiLimits {
  readonly checkoutTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly testTimeoutMs?: number;
  readonly buildTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly outputLimitBytes?: number;
  readonly killGraceMs?: number;
}

export interface CiStageResult extends ProcessResult {
  readonly stage: CiStage;
}

export interface CiRunResult {
  readonly deploymentId: string;
  readonly commitSha: string;
  readonly workspacePath: string;
  readonly stages: readonly CiStageResult[];
}

export interface CiRunnerHooks {
  onStageStarted?(stage: CiStage): Promise<void> | void;
  onStageCompleted?(result: CiStageResult): Promise<void> | void;
  onStageFailed?(stage: CiStage, error: unknown): Promise<void> | void;
}

export interface CiRunnerOptions {
  readonly workspaceRoot: string;
  readonly limits?: CiLimits;
  readonly processRunner?: ProcessRunner;
  readonly workspaceManager?: WorkspaceManager;
}

export class CiStepError extends Error {
  readonly stage: CiStage;
  readonly result?: CiStageResult;
  constructor(stage: CiStage, message: string, result?: CiStageResult) {
    super(message);
    this.name = 'CiStepError';
    this.stage = stage;
    this.result = result;
  }
}

export interface CiRunner {
  run(input: CiRunInput, hooks?: CiRunnerHooks): Promise<CiRunResult>;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateInput(input: CiRunInput): void {
  if (!UUID_PATTERN.test(input.deploymentId)) throw new TypeError('deployment ID is invalid');
  if (!SHA_PATTERN.test(input.commitSha)) throw new TypeError('commit SHA is invalid');
  if (input.packageManager !== 'pnpm' && input.packageManager !== 'npm') {
    throw new TypeError('package manager is invalid');
  }
  if (/\s|[\u0000-\u001f\u007f]/.test(input.repositoryUrl)) {
    throw new TypeError('repository URL is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(input.repositoryUrl);
  } catch {
    throw new TypeError('repository URL is invalid');
  }
  if (!['https:', 'file:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new TypeError('repository URL is not an allowed source');
  }
}

function timeoutFor(stage: CiStage, limits: CiLimits): number | undefined {
  return {
    CHECKOUT: limits.checkoutTimeoutMs,
    INSTALL: limits.installTimeoutMs,
    TEST: limits.testTimeoutMs,
    BUILD: limits.buildTimeoutMs,
  }[stage];
}

function stepCommand(stage: CiStage, manager: PackageManager, sha: string): readonly [string, readonly string[]] {
  if (stage === 'CHECKOUT') return ['git', ['init', '--quiet']];
  if (stage === 'INSTALL') {
    return manager === 'pnpm'
      ? ['pnpm', ['install', '--frozen-lockfile']]
      : ['npm', ['ci']];
  }
  if (stage === 'TEST') return manager === 'pnpm' ? ['pnpm', ['test']] : ['npm', ['test']];
  return manager === 'pnpm' ? ['pnpm', ['run', 'build']] : ['npm', ['run', 'build']];
}

function combineStageResults(stage: CiStage, results: readonly ProcessResult[]): CiStageResult {
  const last = results[results.length - 1];
  if (!last) throw new Error('stage produced no process result');
  return {
    ...last,
    stage,
    stdout: results.map((result) => result.stdout).join(''),
    stderr: results.map((result) => result.stderr).join(''),
    stdoutTruncated: results.some((result) => result.stdoutTruncated),
    stderrTruncated: results.some((result) => result.stderrTruncated),
    durationMs: results.reduce((total, result) => total + result.durationMs, 0),
  };
}

export function createCiRunner(options: CiRunnerOptions): CiRunner {
  const processRunner = options.processRunner ?? defaultProcessRunner;
  const limits = options.limits ?? {};
  const workspaces = options.workspaceManager ?? createWorkspaceManager(options.workspaceRoot);

  return {
    async run(input, hooks = {}) {
      validateInput(input);
      const totalTimeout = limits.totalTimeoutMs;
      if (totalTimeout !== undefined && (!Number.isSafeInteger(totalTimeout) || totalTimeout <= 0)) {
        throw new TypeError('total timeout is invalid');
      }
      const workspace = await workspaces.create();
      const stages: CiStageResult[] = [];
      const controller = new AbortController();
      const totalTimer = totalTimeout === undefined ? undefined : setTimeout(() => controller.abort(), totalTimeout);
      const abort = () => controller.abort();
      input.signal?.addEventListener('abort', abort, { once: true });

      const runProcess = async (stage: CiStage, command: string, args: readonly string[]) => {
        const processOptions: ProcessOptions = {
          cwd: workspace.path,
          timeoutMs: timeoutFor(stage, limits),
          killGraceMs: limits.killGraceMs,
          outputLimitBytes: limits.outputLimitBytes,
          signal: controller.signal,
        };
        try {
          return await processRunner.run(command, args, processOptions);
        } catch (error) {
          await hooks.onStageFailed?.(stage, error);
          throw error;
        }
      };

      try {
        await hooks.onStageStarted?.('CHECKOUT');
        const checkoutResults: ProcessResult[] = [];
        for (const args of [
          ['init', '--quiet'],
          ['remote', 'add', 'origin', input.repositoryUrl],
          ['fetch', '--no-tags', '--depth=1', 'origin', input.commitSha],
          ['checkout', '--detach', '--force', input.commitSha],
        ]) {
          checkoutResults.push(await runProcess('CHECKOUT', 'git', args));
          if (checkoutResults[checkoutResults.length - 1]?.exitCode !== 0) {
            break;
          }
        }
        const checkout = combineStageResults('CHECKOUT', checkoutResults);
        stages.push(checkout);
        await hooks.onStageCompleted?.(checkout);
        if (checkout.exitCode !== 0) throw new CiStepError('CHECKOUT', 'CI checkout failed', checkout);
        const verification = await runProcess('CHECKOUT', 'git', ['rev-parse', 'HEAD']);
        if (verification.exitCode !== 0 || verification.stdout.trim().toLowerCase() !== input.commitSha) {
          throw new CiStepError('CHECKOUT', 'checked out revision did not match requested SHA', {
            ...verification,
            stage: 'CHECKOUT',
          });
        }
        await access(join(workspace.path, input.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'));
        for (const stage of ['INSTALL', 'TEST', 'BUILD'] as const) {
          const [command, args] = stepCommand(stage, input.packageManager, input.commitSha);
          await hooks.onStageStarted?.(stage);
          const result = await runProcess(stage, command, args);
          const stageResult: CiStageResult = { ...result, stage };
          stages.push(stageResult);
          await hooks.onStageCompleted?.(stageResult);
          if (stageResult.exitCode !== 0) throw new CiStepError(stage, `CI ${stage.toLowerCase()} failed`, stageResult);
        }
        return { deploymentId: input.deploymentId, commitSha: input.commitSha, workspacePath: workspace.path, stages };
      } finally {
        if (totalTimer) clearTimeout(totalTimer);
        input.signal?.removeEventListener('abort', abort);
        await workspace.cleanup();
      }
    },
  };
}
