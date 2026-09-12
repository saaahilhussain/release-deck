import { access } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  ProcessCancelledError,
  ProcessTimeoutError,
  boundedUtf8,
  defaultProcessRunner,
  type ProcessResult,
  type ProcessRunner,
  type ProcessOptions,
} from './process.js';
import {
  WorkspaceAllocationCleanupError,
  createWorkspaceManager,
  type Workspace,
  type WorkspaceManager,
} from './workspace.js';

export const CI_STAGES = ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD'] as const;
export type CiStage = (typeof CI_STAGES)[number];
export type PackageManager = 'pnpm' | 'npm';

export interface CiRunInput {
  readonly deploymentId: string;
  readonly repositoryUrl: string;
  readonly commitSha: string;
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
  readonly result: CiStageResult | undefined;
  constructor(stage: CiStage, message: string, result?: CiStageResult) {
    super(message);
    this.name = 'CiStepError';
    this.stage = stage;
    this.result = result;
  }
}

/** Cleanup failed; the worker must treat this as a workspace failure. */
export class CiCleanupError extends Error {
  readonly cleanupError: unknown;
  readonly executionError: unknown;

  constructor(cleanupError: unknown, executionError: unknown = undefined) {
    super('CI workspace cleanup failed');
    this.name = 'CiCleanupError';
    this.cleanupError = cleanupError;
    this.executionError = executionError;
  }
}

export interface CiRunner {
  run(input: CiRunInput, hooks?: CiRunnerHooks): Promise<CiRunResult>;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateInput(input: CiRunInput): void {
  if (!UUID_PATTERN.test(input.deploymentId))
    throw new TypeError('deployment ID is invalid');
  if (!SHA_PATTERN.test(input.commitSha)) throw new TypeError('commit SHA is invalid');
  if (
    /\s/.test(input.repositoryUrl) ||
    [...input.repositoryUrl].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new TypeError('repository URL is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(input.repositoryUrl);
  } catch {
    throw new TypeError('repository URL is invalid');
  }
  if (
    !['https:', 'file:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
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

function stepCommand(
  stage: CiStage,
  manager: PackageManager,
): readonly [string, readonly string[]] {
  if (stage === 'CHECKOUT') return ['git', ['init', '--quiet']];
  if (stage === 'INSTALL') {
    return manager === 'pnpm'
      ? ['pnpm', ['install', '--frozen-lockfile']]
      : ['npm', ['ci']];
  }
  if (stage === 'TEST')
    return manager === 'pnpm' ? ['pnpm', ['test']] : ['npm', ['test']];
  return manager === 'pnpm' ? ['pnpm', ['run', 'build']] : ['npm', ['run', 'build']];
}

async function detectPackageManager(workspacePath: string): Promise<PackageManager> {
  const [pnpm, npm] = await Promise.all([
    access(join(workspacePath, 'pnpm-lock.yaml')).then(
      () => true,
      () => false,
    ),
    access(join(workspacePath, 'package-lock.json')).then(
      () => true,
      () => false,
    ),
  ]);
  if (pnpm === npm)
    throw new Error('exactly one supported package lockfile is required');
  return pnpm ? 'pnpm' : 'npm';
}

function boundedText(
  results: readonly ProcessResult[],
  field: 'stdout' | 'stderr',
  limit: number,
): [string, boolean] {
  const value = Buffer.from(results.map((result) => result[field]).join(''), 'utf8');
  const bounded = boundedUtf8(value, limit);
  return [
    bounded.text,
    bounded.truncated || results.some((result) => result[`${field}Truncated`]),
  ];
}

function combineStageResults(
  stage: CiStage,
  results: readonly ProcessResult[],
  limit: number,
): CiStageResult {
  const last = results[results.length - 1];
  if (!last) throw new Error('stage produced no process result');
  const [stdout, stdoutTruncated] = boundedText(results, 'stdout', limit);
  const [stderr, stderrTruncated] = boundedText(results, 'stderr', limit);
  return {
    ...last,
    stage,
    stdout,
    stderr,
    stdoutTruncated,
    stderrTruncated,
    durationMs: results.reduce((total, result) => total + result.durationMs, 0),
  };
}

export function createCiRunner(options: CiRunnerOptions): CiRunner {
  const processRunner = options.processRunner ?? defaultProcessRunner;
  const limits = options.limits ?? {};
  const workspaces =
    options.workspaceManager ?? createWorkspaceManager(options.workspaceRoot);

  return {
    async run(input, hooks = {}) {
      validateInput(input);
      const totalTimeout = limits.totalTimeoutMs;
      if (
        totalTimeout !== undefined &&
        (!Number.isSafeInteger(totalTimeout) || totalTimeout <= 0)
      ) {
        throw new TypeError('total timeout is invalid');
      }
      let workspace: Workspace;
      try {
        workspace = await workspaces.create();
      } catch (error) {
        if (error instanceof WorkspaceAllocationCleanupError) {
          throw new CiCleanupError(error.cleanupError, error.allocationError);
        }
        throw error;
      }
      const stages: CiStageResult[] = [];
      const controller = new AbortController();
      const stageDeadlines = new Map<CiStage, number>();
      let totalTimedOut = false;
      const totalTimer =
        totalTimeout === undefined
          ? undefined
          : setTimeout(() => {
              totalTimedOut = true;
              controller.abort();
            }, totalTimeout);
      const abort = () => controller.abort();
      if (input.signal?.aborted) controller.abort();
      else input.signal?.addEventListener('abort', abort, { once: true });
      let executionError: unknown;
      let executionFailed = false;
      let executionResult: CiRunResult | undefined;

      const runProcess = async (
        stage: CiStage,
        command: string,
        args: readonly string[],
      ) => {
        const deadline = stageDeadlines.get(stage);
        const remainingTimeout =
          deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
        const processOptions = {
          cwd: workspace.path,
          signal: controller.signal,
          ...(remainingTimeout === undefined ? {} : { timeoutMs: remainingTimeout }),
          ...(limits.killGraceMs === undefined
            ? {}
            : { killGraceMs: limits.killGraceMs }),
          ...(limits.outputLimitBytes === undefined
            ? {}
            : { outputLimitBytes: limits.outputLimitBytes }),
        } as ProcessOptions;
        try {
          return await processRunner.run(command, args, processOptions);
        } catch (error) {
          const reported =
            totalTimedOut && error instanceof ProcessCancelledError
              ? new ProcessTimeoutError(error.result)
              : error;
          await hooks.onStageFailed?.(stage, reported);
          throw reported;
        }
      };

      const startStage = async (stage: CiStage): Promise<void> => {
        const timeout = timeoutFor(stage, limits);
        if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) {
          throw new TypeError(`${stage.toLowerCase()} timeout is invalid`);
        }
        if (timeout !== undefined) stageDeadlines.set(stage, Date.now() + timeout);
        await hooks.onStageStarted?.(stage);
      };

      try {
        await startStage('CHECKOUT');
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
        let checkout = combineStageResults(
          'CHECKOUT',
          checkoutResults,
          limits.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
        );
        if (checkout.exitCode !== 0) {
          const error = new CiStepError('CHECKOUT', 'CI checkout failed', checkout);
          await hooks.onStageFailed?.('CHECKOUT', error);
          throw error;
        }
        const verification = await runProcess('CHECKOUT', 'git', ['rev-parse', 'HEAD']);
        checkout = combineStageResults(
          'CHECKOUT',
          [...checkoutResults, verification],
          limits.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
        );
        if (
          verification.exitCode !== 0 ||
          verification.stdout.trim().toLowerCase() !== input.commitSha
        ) {
          const error = new CiStepError(
            'CHECKOUT',
            'checked out revision did not match requested SHA',
            checkout,
          );
          await hooks.onStageFailed?.('CHECKOUT', error);
          throw error;
        }
        stages.push(checkout);
        await hooks.onStageCompleted?.(checkout);
        await startStage('INSTALL');
        let packageManager: PackageManager;
        try {
          packageManager = await detectPackageManager(workspace.path);
        } catch {
          const stageError = new CiStepError(
            'INSTALL',
            'supported lockfile policy was not satisfied',
          );
          await hooks.onStageFailed?.('INSTALL', stageError);
          throw stageError;
        }
        for (const stage of ['INSTALL', 'TEST', 'BUILD'] as const) {
          const [command, args] = stepCommand(stage, packageManager);
          if (stage !== 'INSTALL') await startStage(stage);
          const result = await runProcess(stage, command, args);
          const stageResult: CiStageResult = { ...result, stage };
          stages.push(stageResult);
          if (stageResult.exitCode !== 0) {
            const error = new CiStepError(
              stage,
              `CI ${stage.toLowerCase()} failed`,
              stageResult,
            );
            await hooks.onStageFailed?.(stage, error);
            throw error;
          }
          await hooks.onStageCompleted?.(stageResult);
        }
        executionResult = {
          deploymentId: input.deploymentId,
          commitSha: input.commitSha,
          workspacePath: workspace.path,
          stages,
        };
      } catch (error) {
        executionFailed = true;
        executionError = error;
      } finally {
        if (totalTimer) clearTimeout(totalTimer);
        input.signal?.removeEventListener('abort', abort);
      }
      try {
        await workspace.cleanup();
      } catch (cleanupError) {
        throw new CiCleanupError(cleanupError, executionError);
      }
      if (executionFailed) throw executionError;
      return executionResult as CiRunResult;
    },
  };
}
