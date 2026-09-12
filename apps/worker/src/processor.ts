import {
  ConcurrencyError,
  type Deployment,
  type DeploymentRepository,
} from '@releasedeck/db';
import type { DeploymentJobData } from '@releasedeck/queue';

export type DeploymentProcessorRepository = Pick<
  DeploymentRepository,
  'findById' | 'transition'
>;

function hasStarted(deployment: Deployment): boolean {
  return deployment.status !== 'QUEUED';
}

/** Begin only the queue-owned portion of execution; later stages belong to later phases. */
export async function processDeploymentJob(
  job: DeploymentJobData,
  deployments: DeploymentProcessorRepository,
): Promise<void> {
  const deployment = await deployments.findById(job.deploymentId);
  if (!deployment) throw new Error('deployment was not found');

  // A redelivered job must never move an already-started deployment backwards.
  if (hasStarted(deployment)) return;
  if (deployment.stage !== 'QUEUED') return;

  try {
    await deployments.transition(job.deploymentId, {
      expectedVersion: deployment.version,
      status: 'RUNNING',
      stage: 'CHECKOUT',
    });
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    const current = await deployments.findById(job.deploymentId);
    if (!current) throw error;
    if (hasStarted(current)) return;
    throw error;
  }
}
