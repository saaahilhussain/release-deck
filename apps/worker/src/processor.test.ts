import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConcurrencyError,
  createProject,
  createQueuedDeployment,
  type CiExecutionClaim,
  type CiExecutionLeaseInput,
  type CiStepOutcomeInput,
  type Deployment,
  type Project,
  type ReleaseExecutionClaim,
  type ReleaseFailureInput,
  type ReleasePromotionInput,
} from '@releasedeck/db';
import {
  CiCleanupError,
  CiStepError,
  ProcessCancelledError,
  ProcessTimeoutError,
  type CiRunner,
  type CiRunnerHooks,
  type CiStage,
  type CiStageResult,
} from '@releasedeck/ci-runner';

import {
  processDeploymentJob,
  type DeploymentReleaseOperations,
  type DeploymentProcessorRepositories,
} from './processor.js';

const deploymentId = '550e8400-e29b-41d4-a716-446655440000';
const projectId = '550e8400-e29b-41d4-a716-446655440001';
const attemptId = '550e8400-e29b-41d4-a716-446655440002';
const job = { deploymentId };
const context = { attemptsMade: 0, maxAttempts: 3 };
const target = {
  host: 'target.example.com',
  port: 22,
  user: 'deployer',
  privateKeyPath: 'D:\\keys\\release',
  knownHostsPath: 'D:\\keys\\known_hosts',
  remoteRoot: '/srv/apps',
  timeoutMs: 60_000,
  outputLimitBytes: 65_536,
  healthUrl: 'http://127.0.0.1:3000/health',
  healthAttempts: 5,
  healthIntervalMs: 1000,
  healthRequestTimeoutMs: 2000,
};
const processorOptions = {
  leaseMs: 60_000,
  activeLeasePollMs: 1,
  release: {
    artifactRoot: 'D:\\artifacts',
    leaseMs: 60_000,
    retention: 5,
    target,
    activeLeasePollMs: 1,
  },
};

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
  const releaseCalls: string[] = [];
  const releaseOperations: DeploymentReleaseOperations = {
    async prepareRelease(input) {
      releaseCalls.push('prepare');
      return {
        projectId: input.projectId,
        deploymentId: input.deploymentId,
        commitSha: input.commitSha,
        archivePath: 'D:\\artifacts\\release.tar.gz',
        metadataPath: 'D:\\artifacts\\metadata.json',
        applicationRoot: '.',
        build: 'required',
        archiveSha256: 'b'.repeat(64),
      };
    },
    async openPreparedRelease() {
      releaseCalls.push('open');
      return {
        projectId,
        deploymentId,
        commitSha: 'a'.repeat(40),
        archivePath: 'D:\\artifacts\\release.tar.gz',
        metadataPath: 'D:\\artifacts\\metadata.json',
        applicationRoot: '.',
        build: 'required',
        archiveSha256: 'b'.repeat(64),
      };
    },
    async stageRelease() {
      releaseCalls.push('stage');
    },
    async promoteRelease(input) {
      releaseCalls.push('activate');
      const releasePath = `/srv/apps/${input.projectId}/releases/${input.deploymentId}`;
      return {
        status: 'PROMOTED',
        proof: {
          projectId: input.projectId,
          deploymentId: input.deploymentId,
          commitSha: input.commitSha,
          remoteReleasePath: releasePath,
          activeTarget: releasePath,
          pm2ProcessName: `releasedeck-${input.projectId}`,
          pm2Pid: 123,
          nginx: { validated: true, reloaded: true },
          completedAt: new Date(),
        },
        healthProof: {
          url: input.target.healthUrl,
          statusCode: 200,
          attempts: 1,
          completedAt: new Date(),
        },
      };
    },
    async cleanupPreparedRelease() {
      releaseCalls.push('cleanup');
    },
  };
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
      claimReleaseExecution: async () => {
        const now = new Date();
        current = {
          ...current,
          status: 'RUNNING',
          stage: 'DEPLOY',
          version: current.version + 1,
          release: {
            status: 'RUNNING',
            releaseId: deploymentId,
            attemptNumber: 1,
            attemptId,
            fence: 1,
            leaseExpiresAt: new Date(now.valueOf() + 60_000),
            heartbeatAt: now,
            startedAt: now,
          },
        };
        return {
          attemptId,
          fence: 1,
          attemptNumber: 1,
          leaseExpiresAt: current.release!.leaseExpiresAt!,
          deployment: current,
        } satisfies ReleaseExecutionClaim;
      },
      reclaimExpiredReleaseExecution: async () => null,
      renewReleaseExecution: async () => current,
      advanceReleaseStage: async (_id, input) => {
        current = { ...current, stage: input.stage, version: current.version + 1 };
        return current;
      },
      recordReleasePromotion: async (_id, input: ReleasePromotionInput) => {
        const { leaseExpiresAt, heartbeatAt, ...release } = current.release!;
        void leaseExpiresAt;
        void heartbeatAt;
        current = {
          ...current,
          status: 'SUCCESS',
          stage: 'COMPLETE',
          version: current.version + 1,
          release: {
            ...release,
            status: 'DEPLOYED',
            success: input.proof,
            health: input.health,
            finishedAt: new Date(),
          },
        };
        return current;
      },
      recordReleaseRollback: async () => current,
      recordReleaseRollbackFailure: async () => current,
      recordReleaseFailure: async (_id, input: ReleaseFailureInput) => {
        current = {
          ...current,
          status: input.failure.retryable ? 'RUNNING' : 'FAILED',
          version: current.version + 1,
          release: {
            ...current.release!,
            status: input.failure.retryable ? 'RETRY_PENDING' : 'FAILED',
            failure: input.failure,
          },
        };
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
    releaseOperations,
    releaseCalls,
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
      if (stage === 'BUILD') {
        await hooks.onBuildReady?.({
          deploymentId: input.deploymentId,
          commitSha: input.commitSha,
          workspacePath: 'D:\\temporary-workspace',
          packageManager: 'pnpm',
          applicationRoot: '.',
          build: 'required',
          buildResult: result,
        });
      }
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renewed(current: Deployment): Deployment {
  const heartbeatAt = new Date();
  return {
    ...current,
    version: current.version + 1,
    updatedAt: heartbeatAt,
    ci: {
      ...current.ci!,
      heartbeatAt,
      leaseExpiresAt: new Date(heartbeatAt.valueOf() + 60_000),
    },
  };
}

function persistenceHarness(
  runner: CiRunner,
  handlers: {
    renew?: (current: Deployment, input: CiExecutionLeaseInput) => Promise<Deployment>;
    outcome?: (current: Deployment, input: CiStepOutcomeInput) => Promise<Deployment>;
  } = {},
) {
  let current = queuedDeployment();
  const active = runningDeployment({ version: 1 });
  const renewalVersions: number[] = [];
  const outcomeVersions: number[] = [];
  const repositories: DeploymentProcessorRepositories = {
    deployments: {
      findById: async () => current,
      claimCiExecution: async () => {
        current = active;
        return claim(active);
      },
      reclaimExpiredCiExecution: async () => null,
      renewCiExecution: async (_id, input) => {
        renewalVersions.push(input.expectedVersion);
        if (
          input.expectedVersion !== current.version ||
          input.attemptId !== current.ci?.attemptId ||
          input.fence !== current.ci.fence
        )
          throw new ConcurrencyError();
        current = handlers.renew
          ? await handlers.renew(current, input)
          : renewed(current);
        return current;
      },
      recordCiStepOutcome: async (_id, input) => {
        outcomeVersions.push(input.expectedVersion);
        if (
          input.expectedVersion !== current.version ||
          input.attemptId !== current.ci?.attemptId ||
          input.fence !== current.ci.fence
        )
          throw new ConcurrencyError();
        current = handlers.outcome
          ? await handlers.outcome(current, input)
          : applyOutcome(current, input);
        return current;
      },
      claimReleaseExecution: async () => {
        const now = new Date();
        current = {
          ...current,
          stage: 'DEPLOY',
          version: current.version + 1,
          release: {
            status: 'RUNNING',
            releaseId: deploymentId,
            attemptNumber: 1,
            attemptId,
            fence: 1,
            leaseExpiresAt: new Date(now.valueOf() + 60_000),
            heartbeatAt: now,
            startedAt: now,
          },
        };
        const leaseExpiresAt = current.release!.leaseExpiresAt!;
        return {
          attemptId,
          fence: 1,
          attemptNumber: 1,
          leaseExpiresAt,
          deployment: current,
        };
      },
      reclaimExpiredReleaseExecution: async () => null,
      renewReleaseExecution: async () => current,
      advanceReleaseStage: async (_id, input) => {
        current = { ...current, stage: input.stage, version: current.version + 1 };
        return current;
      },
      recordReleasePromotion: async (_id, input) => {
        current = {
          ...current,
          status: 'SUCCESS',
          stage: 'COMPLETE',
          version: current.version + 1,
          release: {
            ...current.release!,
            status: 'DEPLOYED',
            success: input.proof,
            health: input.health,
            finishedAt: new Date(),
          },
        };
        return current;
      },
      recordReleaseRollback: async () => current,
      recordReleaseRollbackFailure: async () => current,
      recordReleaseFailure: async () => current,
    },
    projects: { findById: async () => project() },
  };
  return {
    repositories,
    runner,
    renewalVersions,
    outcomeVersions,
    current: () => current,
    replaceCurrent: (deployment: Deployment) => {
      current = deployment;
    },
  };
}

const inactiveReleaseOperations: DeploymentReleaseOperations = {
  async prepareRelease() {
    throw new Error('release preparation is not expected');
  },
  async openPreparedRelease() {
    throw new Error('release opening is not expected');
  },
  async stageRelease() {
    throw new Error('release staging is not expected');
  },
  async promoteRelease() {
    throw new Error('release promotion is not expected');
  },
  async cleanupPreparedRelease() {},
};

const successfulReleaseOperations: DeploymentReleaseOperations = {
  async prepareRelease() {
    throw new Error('release preparation is not expected');
  },
  async openPreparedRelease() {
    return {
      projectId,
      deploymentId,
      commitSha: 'a'.repeat(40),
      archivePath: 'D:\\artifacts\\release.tar.gz',
      metadataPath: 'D:\\artifacts\\metadata.json',
      applicationRoot: '.',
      build: 'required',
      archiveSha256: 'b'.repeat(64),
    };
  },
  async stageRelease() {},
  async promoteRelease() {
    const releasePath = `/srv/apps/${projectId}/releases/${deploymentId}`;
    return {
      status: 'PROMOTED',
      proof: {
        projectId,
        deploymentId,
        commitSha: 'a'.repeat(40),
        remoteReleasePath: releasePath,
        activeTarget: releasePath,
        pm2ProcessName: `releasedeck-${projectId}`,
        pm2Pid: 123,
        nginx: { validated: true, reloaded: true },
        completedAt: new Date(),
      },
      healthProof: {
        url: target.healthUrl,
        statusCode: 200,
        attempts: 1,
        completedAt: new Date(),
      },
    };
  },
  async cleanupPreparedRelease() {},
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
  await processDeploymentJob(
    job,
    context,
    state.repositories,
    state.runner,
    state.releaseOperations,
    processorOptions,
  );
  assert.equal(repositoryUrl, 'https://github.com/releasedeck-org/releasedeck-app.git');
  assert.deepEqual(
    state.outcomes.map((outcome) => outcome.stage),
    ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD'],
  );
  assert.equal(state.current().status, 'SUCCESS');
  assert.equal(state.current().stage, 'COMPLETE');
  assert.equal(state.current().ci?.status, 'PASSED');
  assert.equal(state.current().ci?.cleanup?.status, 'CLEANED');
  assert.equal(state.current().release?.status, 'DEPLOYED');
  assert.deepEqual(state.releaseCalls, [
    'prepare',
    'open',
    'stage',
    'activate',
    'cleanup',
  ]);
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
  await processDeploymentJob(
    job,
    context,
    state.repositories,
    state.runner,
    state.releaseOperations,
    processorOptions,
  );
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
    processDeploymentJob(
      job,
      context,
      state.repositories,
      state.runner,
      state.releaseOperations,
      processorOptions,
    ),
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

test('terminal workspace cleanup failure removes an already-prepared artifact', async () => {
  const runner: CiRunner = {
    async run(input, hooks) {
      await successfulRunner.run(input, hooks);
      throw new CiCleanupError(new Error('workspace cleanup unavailable'));
    },
  };
  const state = harness({ runner });
  await processDeploymentJob(
    job,
    { attemptsMade: 2, maxAttempts: 3 },
    state.repositories,
    state.runner,
    state.releaseOperations,
    processorOptions,
  );
  assert.equal(state.current().status, 'FAILED');
  assert.equal(state.current().ci?.failure?.kind, 'WORKSPACE_FAILED');
  assert.deepEqual(state.releaseCalls, ['prepare', 'cleanup']);
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
    processDeploymentJob(
      job,
      context,
      state.repositories,
      state.runner,
      state.releaseOperations,
      processorOptions,
    ),
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
    status: 'SUCCESS',
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
      claimReleaseExecution: async () => null,
      reclaimExpiredReleaseExecution: async () => null,
      renewReleaseExecution: async () => passed,
      advanceReleaseStage: async () => passed,
      recordReleasePromotion: async () => passed,
      recordReleaseRollback: async () => passed,
      recordReleaseRollbackFailure: async () => passed,
      recordReleaseFailure: async () => passed,
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
    {
      prepareRelease: async () => {
        throw new Error('release preparation must not run');
      },
      openPreparedRelease: async () => {
        throw new Error('prepared release must not be opened');
      },
      stageRelease: async () => {
        throw new Error('release staging must not run');
      },
      promoteRelease: async () => {
        throw new Error('release activation must not run');
      },
      cleanupPreparedRelease: async () => undefined,
    },
    processorOptions,
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
  await processDeploymentJob(
    job,
    context,
    state.repositories,
    state.runner,
    state.releaseOperations,
    processorOptions,
  );
  assert.equal(state.runs(), 1);
});

test('a missing project becomes a terminal checkout failure', async () => {
  const state = harness({ runner: successfulRunner, project: null });
  await processDeploymentJob(
    job,
    context,
    state.repositories,
    state.runner,
    state.releaseOperations,
    processorOptions,
  );
  assert.equal(state.runs(), 0);
  assert.equal(state.current().status, 'FAILED');
  assert.equal(state.current().stage, 'CHECKOUT');
  assert.equal(state.outcomes[0]?.exitCode, null);
  assert.equal(state.outcomes[0]?.signal, null);
});

test('a successful outcome uses the version committed by the heartbeat and stops renewal', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const runnerStarted = deferred();
  const heartbeatCommitted = deferred();
  const runner: CiRunner = {
    async run(_input, hooks = {}) {
      runnerStarted.resolve();
      await heartbeatCommitted.promise;
      await hooks.onStageStarted?.('BUILD');
      await hooks.onStageCompleted?.(stageResult('BUILD'));
      return {
        deploymentId,
        commitSha: 'a'.repeat(40),
        workspacePath: 'D:\\temporary-workspace',
        stages: [stageResult('BUILD')],
      };
    },
  };
  const state = persistenceHarness(runner, {
    async renew(current) {
      const next = renewed(current);
      heartbeatCommitted.resolve();
      return next;
    },
  });

  const processing = processDeploymentJob(
    job,
    { attemptsMade: 0, maxAttempts: 1 },
    state.repositories,
    state.runner,
    successfulReleaseOperations,
    processorOptions,
  );
  await runnerStarted.promise;
  t.mock.timers.tick(20_000);
  await processing;

  assert.deepEqual(state.renewalVersions, [1]);
  assert.deepEqual(state.outcomeVersions, [2]);
  assert.equal(state.current().ci?.status, 'PASSED');
  t.mock.timers.tick(100_000);
  assert.deepEqual(state.renewalVersions, [1]);
});

test('a failed outcome waits for an in-flight heartbeat before using its version', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const runnerStarted = deferred();
  const heartbeatStarted = deferred();
  const releaseHeartbeat = deferred();
  const runner: CiRunner = {
    async run(_input, hooks = {}) {
      runnerStarted.resolve();
      await heartbeatStarted.promise;
      await hooks.onStageStarted?.('TEST');
      const error = new CiStepError('TEST', 'CI test failed', stageResult('TEST', 1));
      await hooks.onStageFailed?.('TEST', error);
      throw error;
    },
  };
  const state = persistenceHarness(runner, {
    async renew(current) {
      heartbeatStarted.resolve();
      await releaseHeartbeat.promise;
      return renewed(current);
    },
  });

  const processing = processDeploymentJob(
    job,
    { attemptsMade: 0, maxAttempts: 1 },
    state.repositories,
    state.runner,
    inactiveReleaseOperations,
    processorOptions,
  );
  await runnerStarted.promise;
  t.mock.timers.tick(20_000);
  await heartbeatStarted.promise;
  await Promise.resolve();
  assert.deepEqual(state.outcomeVersions, []);
  releaseHeartbeat.resolve();
  await processing;

  assert.deepEqual(state.renewalVersions, [1]);
  assert.deepEqual(state.outcomeVersions, [2]);
  assert.equal(state.current().ci?.status, 'FAILED');
});

test('multiple heartbeats serialize and publish each committed version', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const runnerStarted = deferred();
  const finishRunner = deferred();
  const firstHeartbeatStarted = deferred();
  const releaseFirstHeartbeat = deferred();
  const secondHeartbeatStarted = deferred();
  let renewCalls = 0;
  const runner: CiRunner = {
    async run(_input, hooks = {}) {
      runnerStarted.resolve();
      await finishRunner.promise;
      await hooks.onStageStarted?.('TEST');
      const error = new CiStepError('TEST', 'CI test failed', stageResult('TEST', 1));
      await hooks.onStageFailed?.('TEST', error);
      throw error;
    },
  };
  const state = persistenceHarness(runner, {
    async renew(current) {
      renewCalls += 1;
      if (renewCalls === 1) {
        firstHeartbeatStarted.resolve();
        await releaseFirstHeartbeat.promise;
      } else if (renewCalls === 2) {
        secondHeartbeatStarted.resolve();
      }
      return renewed(current);
    },
  });

  const processing = processDeploymentJob(
    job,
    { attemptsMade: 0, maxAttempts: 1 },
    state.repositories,
    state.runner,
    inactiveReleaseOperations,
    processorOptions,
  );
  await runnerStarted.promise;
  t.mock.timers.tick(20_000);
  await firstHeartbeatStarted.promise;
  t.mock.timers.tick(20_000);
  await Promise.resolve();
  assert.equal(renewCalls, 1);
  releaseFirstHeartbeat.resolve();
  await secondHeartbeatStarted.promise;
  finishRunner.resolve();
  await processing;

  assert.deepEqual(state.renewalVersions, [1, 2]);
  assert.deepEqual(state.outcomeVersions, [3]);
});

test('cancellation waits for an in-flight heartbeat before persisting failure', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const controller = new AbortController();
  const runnerStarted = deferred();
  const heartbeatStarted = deferred();
  const releaseHeartbeat = deferred();
  const runner: CiRunner = {
    async run(input, hooks = {}) {
      runnerStarted.resolve();
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      const error = new ProcessCancelledError(stageResult('TEST', null, 'SIGTERM'));
      await hooks.onStageFailed?.('TEST', error);
      throw error;
    },
  };
  const state = persistenceHarness(runner, {
    async renew(current) {
      heartbeatStarted.resolve();
      await releaseHeartbeat.promise;
      return renewed(current);
    },
  });

  const processing = processDeploymentJob(
    job,
    { attemptsMade: 0, maxAttempts: 1, signal: controller.signal },
    state.repositories,
    state.runner,
    inactiveReleaseOperations,
    processorOptions,
  );
  await runnerStarted.promise;
  t.mock.timers.tick(20_000);
  await heartbeatStarted.promise;
  controller.abort();
  await Promise.resolve();
  assert.deepEqual(state.outcomeVersions, []);
  releaseHeartbeat.resolve();
  await processing;

  assert.deepEqual(state.outcomeVersions, [2]);
  assert.equal(state.current().ci?.failure?.kind, 'CANCELLED');
});

test('timeout waits for an in-flight heartbeat before persisting failure', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const runnerStarted = deferred();
  const heartbeatStarted = deferred();
  const releaseHeartbeat = deferred();
  const triggerTimeout = deferred();
  const runner: CiRunner = {
    async run(_input, hooks = {}) {
      runnerStarted.resolve();
      await triggerTimeout.promise;
      const error = new ProcessTimeoutError(stageResult('TEST', null, 'SIGTERM'));
      await hooks.onStageFailed?.('TEST', error);
      throw error;
    },
  };
  const state = persistenceHarness(runner, {
    async renew(current) {
      heartbeatStarted.resolve();
      await releaseHeartbeat.promise;
      return renewed(current);
    },
  });

  const processing = processDeploymentJob(
    job,
    { attemptsMade: 0, maxAttempts: 1 },
    state.repositories,
    state.runner,
    inactiveReleaseOperations,
    processorOptions,
  );
  await runnerStarted.promise;
  t.mock.timers.tick(20_000);
  await heartbeatStarted.promise;
  triggerTimeout.resolve();
  await Promise.resolve();
  assert.deepEqual(state.outcomeVersions, []);
  releaseHeartbeat.resolve();
  await processing;

  assert.deepEqual(state.outcomeVersions, [2]);
  assert.equal(state.current().ci?.failure?.kind, 'COMMAND_TIMEOUT');
});

test('a different worker remains rejected by optimistic concurrency and fencing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const runnerStarted = deferred();
  const runner: CiRunner = {
    async run(input) {
      runnerStarted.resolve();
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new ProcessCancelledError(stageResult('TEST', null, 'SIGTERM'));
    },
  };
  const state = persistenceHarness(runner);

  const processing = processDeploymentJob(
    job,
    { attemptsMade: 0, maxAttempts: 1 },
    state.repositories,
    state.runner,
    inactiveReleaseOperations,
    processorOptions,
  );
  await runnerStarted.promise;
  state.replaceCurrent({
    ...state.current(),
    ci: {
      ...state.current().ci!,
      attemptId: '550e8400-e29b-41d4-a716-446655440003',
      fence: 2,
    },
  });
  t.mock.timers.tick(20_000);
  await assert.rejects(processing, ConcurrencyError);
  assert.deepEqual(state.outcomeVersions, []);
});

test('a failed mutation prevents queued heartbeats and outcomes from using stale state', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const runnerStarted = deferred();
  const firstHeartbeatStarted = deferred();
  const failHeartbeat = deferred();
  const persistenceError = new Error('MongoDB unavailable');
  let renewCalls = 0;
  const runner: CiRunner = {
    async run(input) {
      runnerStarted.resolve();
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new ProcessCancelledError(stageResult('TEST', null, 'SIGTERM'));
    },
  };
  const state = persistenceHarness(runner, {
    async renew() {
      renewCalls += 1;
      firstHeartbeatStarted.resolve();
      await failHeartbeat.promise;
      throw persistenceError;
    },
  });

  const processing = processDeploymentJob(
    job,
    { attemptsMade: 0, maxAttempts: 1 },
    state.repositories,
    state.runner,
    inactiveReleaseOperations,
    processorOptions,
  );
  await runnerStarted.promise;
  t.mock.timers.tick(20_000);
  await firstHeartbeatStarted.promise;
  t.mock.timers.tick(20_000);
  failHeartbeat.resolve();
  await assert.rejects(processing, persistenceError);

  assert.equal(renewCalls, 1);
  assert.deepEqual(state.outcomeVersions, []);
});
