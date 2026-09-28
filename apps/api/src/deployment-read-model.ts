import type { DeploymentRecord } from './services.js';

function iso(value: Date): string {
  return new Date(value).toISOString();
}

export function deploymentListResponse(deployment: DeploymentRecord) {
  return {
    id: deployment.id,
    projectId: deployment.projectId,
    provider: deployment.provider,
    commitSha: deployment.commitSha,
    status: deployment.status,
    stage: deployment.stage,
    version: deployment.version,
    createdAt: iso(deployment.createdAt),
    updatedAt: iso(deployment.updatedAt),
  };
}

type Activity = {
  kind: 'CI_STEP' | 'CI' | 'RELEASE' | 'HEALTH' | 'ROLLBACK' | 'MANUAL_ROLLBACK';
  label: string;
  occurredAt: string;
  outcome?: string;
};

export function deploymentDetailResponse(deployment: DeploymentRecord) {
  const activity: Activity[] = [];
  const ci = deployment.ci;
  const release = deployment.release;

  if (ci) {
    for (const step of ci.stepResults.slice(0, 4)) {
      activity.push({
        kind: 'CI_STEP',
        label: `${step.stage.toLowerCase()} completed`,
        occurredAt: iso(step.finishedAt),
        outcome: step.status,
      });
    }
    if (ci.finishedAt) {
      activity.push({
        kind: 'CI',
        label: 'CI completed',
        occurredAt: iso(ci.finishedAt),
        outcome: ci.status,
      });
    }
  }

  if (release) {
    if (release.success) {
      activity.push({
        kind: 'RELEASE',
        label: 'Release promoted',
        occurredAt: iso(release.success.completedAt),
        outcome: 'DEPLOYED',
      });
    } else if (release.finishedAt) {
      activity.push({
        kind: 'RELEASE',
        label: 'Release attempt completed',
        occurredAt: iso(release.finishedAt),
        outcome: release.status,
      });
    }
    if (release.health) {
      activity.push({
        kind: 'HEALTH',
        label: 'Application health verified',
        occurredAt: iso(release.health.completedAt),
        outcome: 'HEALTHY',
      });
    }
    if (release.rollback) {
      activity.push({
        kind: 'ROLLBACK',
        label: `${release.rollback.mode.toLowerCase()} rollback completed`,
        occurredAt: iso(release.rollback.completedAt),
        outcome: release.rollback.outcome,
      });
    }
    if (release.manualRollback) {
      activity.push({
        kind: 'MANUAL_ROLLBACK',
        label: release.manualRollback.finishedAt
          ? 'Manual rollback completed'
          : 'Manual rollback requested',
        occurredAt: iso(
          release.manualRollback.finishedAt ?? release.manualRollback.startedAt,
        ),
        outcome: release.manualRollback.status,
      });
    }
  }

  activity.sort((left, right) =>
    left.occurredAt === right.occurredAt
      ? left.kind.localeCompare(right.kind)
      : left.occurredAt.localeCompare(right.occurredAt),
  );

  return {
    ...deploymentListResponse(deployment),
    ...(ci
      ? {
          ci: {
            status: ci.status,
            ...(ci.startedAt ? { startedAt: iso(ci.startedAt) } : {}),
            ...(ci.finishedAt ? { finishedAt: iso(ci.finishedAt) } : {}),
            ...(ci.failure ? { failureKind: ci.failure.kind } : {}),
            steps: ci.stepResults.slice(0, 4).map((step) => ({
              stage: step.stage,
              status: step.status,
              startedAt: iso(step.startedAt),
              finishedAt: iso(step.finishedAt),
              durationMs: step.durationMs,
              exitCode: step.exitCode,
            })),
          },
        }
      : {}),
    ...(release
      ? {
          release: {
            status: release.status,
            releaseId: release.releaseId,
            ...(release.startedAt ? { startedAt: iso(release.startedAt) } : {}),
            ...(release.finishedAt ? { finishedAt: iso(release.finishedAt) } : {}),
            ...(release.failure ? { failureKind: release.failure.kind } : {}),
            ...(release.success
              ? {
                  success: {
                    releaseId: release.success.releaseId,
                    commitSha: release.success.commitSha,
                    completedAt: iso(release.success.completedAt),
                    nginx: {
                      validated: release.success.nginx.validated,
                      reloaded: release.success.nginx.reloaded,
                    },
                  },
                }
              : {}),
            ...(release.health
              ? {
                  health: {
                    statusCode: release.health.statusCode,
                    attempts: release.health.attempts,
                    completedAt: iso(release.health.completedAt),
                  },
                }
              : {}),
            ...(release.rollback
              ? {
                  rollback: {
                    mode: release.rollback.mode,
                    outcome: release.rollback.outcome,
                    targetDeploymentId: release.rollback.target.deploymentId,
                    targetReleaseId: release.rollback.target.releaseId,
                    targetCommitSha: release.rollback.target.commitSha,
                    ...(release.rollback.health
                      ? {
                          health: {
                            statusCode: release.rollback.health.statusCode,
                            attempts: release.rollback.health.attempts,
                            completedAt: iso(release.rollback.health.completedAt),
                          },
                        }
                      : {}),
                    completedAt: iso(release.rollback.completedAt),
                  },
                }
              : {}),
            ...(release.manualRollback
              ? {
                  manualRollback: {
                    status: release.manualRollback.status,
                    targetDeploymentId: release.manualRollback.targetDeploymentId,
                    startedAt: iso(release.manualRollback.startedAt),
                    ...(release.manualRollback.finishedAt
                      ? { finishedAt: iso(release.manualRollback.finishedAt) }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    activity: activity.slice(-12),
  };
}
