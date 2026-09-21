import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProject,
  createQueuedDeployment,
  type CiExecutionClaim,
  type CiStepOutcomeInput,
  type Deployment,
  type Project,
} from '@releasedeck/db';
import {
  CiCleanupError,
  CiStepError,
  ProcessTimeoutError,
  type CiRunner,
  type CiRunnerHooks,
  type CiStage,
  type CiStageResult,
} from '@releasedeck/ci-runner';

import {
  processDeploymentJob,
  type DeploymentProcessorRepositories,
} from './processor.js';

const deploymentId = '550e8400-e29b-41d4-a716-446655440000';
const projectId = '550e8400-e29b-41d4-a716-446655440001';
const attemptId = '550e8400-e29b-41d4-a716-446655440002';
const job = { deploymentId };
const context = { attemptsMade: 0, maxAttempts: 3 };

function project(): Project {
  return {
    ...createProject({ owner: 'ReleaseDeck-Org', repository: 'ReleaseDeck-App' }),
    id: projectId,
  };
}

function queuedDeployment(): Deployment {
  return {
    ...createQueuedDeployment({ projectId, commitSha: 'a'.repeat(40) }),
    id: deploymentId,
  };
}

function runningDeployment(overrides: Partial<Deployment> = {}): Deployment {
  const now = new Date();
  return {
    ...queuedDeployment(),
    status: 'RUNNING',
    stage: 'CHECKOUT',
    version: 2,
    ci: {
      status: 'RUNNING',
      attemptNumber: 1,
      attemptId,
      fence: 1,
      leaseExpiresAt: new Date(now.valueOf() + 60_000),
      heartbeatAt: now,
      startedAt: now,
      stepResults: [],
    },
    ...overrides,
  };
}

function claim(deployment = runningDeployment()): CiExecutionClaim {
  return {
    attemptId,
    fence: 1,
    attemptNumber: 1,
    leaseExpiresAt: deployment.ci!.leaseExpiresAt!,
    deployment,
  };
}

function stageResult(
  stage: CiStage,
  exitCode: number | null = 0,
  signal: CiStageResult['signal'] = null,
): CiStageResult {
  return {
    stage,
    command: stage === 'CHECKOUT' ? 'git' : 'npm',
    args: [],
    exitCode,
    signal,
    stdout: `${stage.toLowerCase()} output`,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 5,
  };
}

function applyOutcome(current: Deployment, outcome: CiStepOutcomeInput): Deployment {
  const now = outcome.finishedAt;
  const result = {
    stage: outcome.stage,
    status: outcome.status,
    attemptId: outcome.attemptId,
    fence: outcome.fence,
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: outcome.stdout ?? '',
    stderr: outcome.stderr ?? '',
    stdoutTruncated: outcome.stdoutTruncated ?? false,
    stderrTruncated: outcome.stderrTruncated ?? false,
    ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
  };
  const results = [...(current.ci?.stepResults ?? []), result];
  const nextStage = {
    CHECKOUT: 'INSTALL',
    INSTALL: 'TEST',
    TEST: 'BUILD',
    BUILD: 'BUILD',
  } as const;
  if (outcome.status === 'PASSED') {
    const passed = outcome.stage === 'BUILD';
    const { leaseExpiresAt, heartbeatAt, ...ciWithoutLease } = current.ci!;
    void leaseExpiresAt;
    void heartbeatAt;
    return {
      ...current,
      stage: nextStage[outcome.stage],
      version: current.version + 1,
      updatedAt: now,
      ci: {
        ...(passed ? ciWithoutLease : current.ci!),
        status: passed ? 'PASSED' : 'RUNNING',
        stepResults: results,
        ...(outcome.cleanup === undefined ? {} : { cleanup: outcome.cleanup }),
        ...(passed ? { finishedAt: now } : {}),
      },
    };
  }
  const failure = outcome.failure!;
  const retryable = failure.retryable;
  const { leaseExpiresAt, heartbeatAt, ...ciWithoutLease } = current.ci!;
  void leaseExpiresAt;
  void heartbeatAt;
  return {
    ...current,
    status: retryable ? 'RUNNING' : 'FAILED',
    version: current.version + 1,
    updatedAt: now,
    ci: {
      ...ciWithoutLease,
      status: retryable
        ? 'RETRY_PENDING'
        : outcome.status === 'TIMED_OUT'
          ? 'TIMED_OUT'
          : 'FAILED',
      stepResults: results,
      failure,
      cleanup: outcome.cleanup!,
      ...(retryable ? {} : { finishedAt: now }),
    },
  };
}

function harness(overrides: {
  initial?: Deployment;
  project?: Project | null;
  runner: CiRunner;
  claim?: CiExecutionClaim | null;
  reclaim?: CiExecutionClaim | null;
}) {
  let current = overrides.initial ?? queuedDeployment();
  const outcomes: CiStepOutcomeInput[] = [];
  let runs = 0;
  const repositories: DeploymentProcessorRepositories = {
    deployments: {
      findById: async () => current,
      claimCiExecution: async () =>
        'claim' in overrides ? (overrides.claim ?? null) : claim(),
      reclaimExpiredCiExecution: async () =>
        'reclaim' in overrides ? (overrides.reclaim ?? null) : null,
      renewCiExecution: async () => current,
      recordCiStepOutcome: async (_id, outcome) => {
        outcomes.push(outcome);
        current = applyOutcome(
          current.status === 'QUEUED' ? claim().deployment : current,
          outcome,
        );
        return current;
      },
    },
    projects: {
      findById: async () =>
        'project' in overrides ? (overrides.project ?? null) : project(),
    },
  };
  const runner: CiRunner = {
    async run(input, hooks) {
      runs += 1;
      return overrides.runner.run(input, hooks);
    },
  };
  return {
    repositories,
    runner,
    outcomes,
    current: () => current,
    runs: () => runs,
  };
}

const successfulRunner: CiRunner = {
  async run(input, hooks: CiRunnerHooks = {}) {
    const results: CiStageResult[] = [];
    for (const stage of ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD'] as const) {
      await hooks.onStageStarted?.(stage);
      const result = stageResult(stage);
      results.push(result);
      await hooks.onStageCompleted?.(result);
    }
    return {
      deploymentId: input.deploymentId,
      commitSha: input.commitSha,
      workspacePath: 'temporary-workspace',
      stages: results,
    };
  },
};

test('worker runs exact repository input through all CI stages and persists PASSED', async () => {
  let repositoryUrl = '';
  const base = successfulRunner;
  const runner: CiRunner = {
    async run(input, hooks) {
      repositoryUrl = input.repositoryUrl;
      return base.run(input, hooks);
    },
  };
  const state = harness({ runner });
  await processDeploymentJob(job, context, state.repositories, state.runner, {
    leaseMs: 60_000,
  });
  assert.equal(repositoryUrl, 'https://github.com/releasedeck-org/releasedeck-app.git');
  assert.deepEqual(
    state.outcomes.map((outcome) => outcome.stage),
    ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD'],
  );
  assert.equal(state.current().status, 'RUNNING');
  assert.equal(state.current().stage, 'BUILD');
  assert.equal(state.current().ci?.status, 'PASSED');
  assert.equal(state.current().ci?.cleanup?.status, 'CLEANED');
  assert.deepEqual(
    state.outcomes.map(({ exitCode, signal }) => ({ exitCode, signal })),
    Array.from({ length: 4 }, () => ({ exitCode: 0, signal: null })),
  );
});

test('a test failure is terminal at TEST and later stages do not run', async () => {
  const ran: CiStage[] = [];
  const runner: CiRunner = {
    async run(input, hooks = {}) {
      for (const stage of ['CHECKOUT', 'INSTALL'] as const) {
        ran.push(stage);
        await hooks.onStageStarted?.(stage);
        await hooks.onStageCompleted?.(stageResult(stage));
      }
      ran.push('TEST');
      await hooks.onStageStarted?.('TEST');
      const error = new CiStepError('TEST', 'CI test failed', stageResult('TEST', 1));
      await hooks.onStageFailed?.('TEST', error);
      throw error;
    },
  };
  const state = harness({ runner });
  await processDeploymentJob(job, context, state.repositories, state.runner, {
    leaseMs: 60_000,
  });
  assert.deepEqual(ran, ['CHECKOUT', 'INSTALL', 'TEST']);
  assert.equal(state.current().status, 'FAILED');
  assert.equal(state.current().stage, 'TEST');
  assert.equal(state.current().ci?.failure?.kind, 'TEST_FAILED');
  assert.equal(state.current().ci?.cleanup?.status, 'CLEANED');
  assert.equal(state.current().ci?.stepResults.at(-1)?.exitCode, 1);
  assert.equal(state.current().ci?.stepResults.at(-1)?.signal, null);
});

test('workspace cleanup failure is persisted without losing the failed stage output', async () => {
  const original = new CiStepError(
    'TEST',
    'CI test failed',
    stageResult('TEST', null, 'SIGTERM'),
  );
  const runner: CiRunner = {
    async run(_input, hooks = {}) {
      for (const stage of ['CHECKOUT', 'INSTALL'] as const) {
        await hooks.onStageStarted?.(stage);
        await hooks.onStageCompleted?.(stageResult(stage));
      }
      await hooks.onStageStarted?.('TEST');
      await hooks.onStageFailed?.('TEST', original);
      throw new CiCleanupError(new Error('cleanup unavailable'), original);
    },
  };
  const state = harness({ runner });

  await assert.rejects(
    processDeploymentJob(job, context, state.repositories, state.runner, {
      leaseMs: 60_000,
    }),
    CiCleanupError,
  );
  assert.equal(state.current().stage, 'TEST');
  assert.equal(state.current().ci?.status, 'RETRY_PENDING');
  assert.equal(state.current().ci?.failure?.kind, 'WORKSPACE_FAILED');
  assert.equal(state.current().ci?.cleanup?.status, 'FAILED');
  assert.equal(state.current().ci?.stepResults.at(-1)?.stdout, 'test output');
  assert.equal(state.current().ci?.stepResults.at(-1)?.exitCode, null);
  assert.equal(state.current().ci?.stepResults.at(-1)?.signal, 'SIGTERM');
});

test('a retryable checkout timeout is persisted and rejected for BullMQ retry', async () => {
  const timeout = new ProcessTimeoutError(stageResult('CHECKOUT', 1));
  const runner: CiRunner = {
    async run(_input, hooks = {}) {
      await hooks.onStageStarted?.('CHECKOUT');
      await hooks.onStageFailed?.('CHECKOUT', timeout);
      throw timeout;
    },
  };
  const state = harness({ runner });
  await assert.rejects(
    processDeploymentJob(job, context, state.repositories, state.runner, {
      leaseMs: 60_000,
    }),
    ProcessTimeoutError,
  );
  assert.equal(state.current().ci?.status, 'RETRY_PENDING');
  assert.equal(state.current().ci?.failure?.kind, 'COMMAND_TIMEOUT');
});

test('an active duplicate waits for authoritative completion and runs nothing', async () => {
  const active = runningDeployment({
    ci: {
      ...runningDeployment().ci!,
      leaseExpiresAt: new Date(Date.now() + 5_000),
    },
  });
  const passed: Deployment = {
    ...active,
    stage: 'BUILD',
    ci: (() => {
      const { leaseExpiresAt, heartbeatAt, ...rest } = active.ci!;
      void leaseExpiresAt;
      void heartbeatAt;
      return { ...rest, status: 'PASSED' as const };
    })(),
  };
  let reads = 0;
  let runs = 0;
  const repositories: DeploymentProcessorRepositories = {
    deployments: {
      findById: async () => (++reads === 1 ? active : passed),
      claimCiExecution: async () => null,
      reclaimExpiredCiExecution: async () => null,
      renewCiExecution: async () => passed,
      recordCiStepOutcome: async () => passed,
    },
    projects: { findById: async () => project() },
  };
  await processDeploymentJob(
    job,
    context,
    repositories,
    {
      run: async () => {
        runs += 1;
        return {
          deploymentId,
          commitSha: 'a'.repeat(40),
          workspacePath: '',
          stages: [],
        };
      },
    },
    { leaseMs: 60_000, activeLeasePollMs: 1 },
  );
  assert.equal(runs, 0);
  assert.ok(reads >= 2);
});

test('an expired attempt is reclaimed before CI runs', async () => {
  const expired = runningDeployment({
    ci: {
      ...runningDeployment().ci!,
      leaseExpiresAt: new Date(Date.now() - 1),
    },
  });
  const reclaimed = claim(runningDeployment({ version: 3 }));
  const state = harness({
    initial: expired,
    runner: successfulRunner,
    reclaim: reclaimed,
  });
  await processDeploymentJob(job, context, state.repositories, state.runner, {
    leaseMs: 60_000,
  });
  assert.equal(state.runs(), 1);
});

test('a missing project becomes a terminal checkout failure', async () => {
  const state = harness({ runner: successfulRunner, project: null });
  await processDeploymentJob(job, context, state.repositories, state.runner, {
    leaseMs: 60_000,
  });
  assert.equal(state.runs(), 0);
  assert.equal(state.current().status, 'FAILED');
  assert.equal(state.current().stage, 'CHECKOUT');
  assert.equal(state.outcomes[0]?.exitCode, null);
  assert.equal(state.outcomes[0]?.signal, null);
});
