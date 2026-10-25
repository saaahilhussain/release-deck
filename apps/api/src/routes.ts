import type { Request, Router } from 'express';
import express from 'express';
import {
  deploymentDetailResponse,
  deploymentListResponse,
} from './deployment-read-model.js';
import { BadRequestError, ServiceUnavailableError } from './errors.js';
import {
  createProjectSchema,
  deploymentPathSchema,
  listQuerySchema,
  projectPathSchema,
  projectIdSchema,
} from './schemas.js';
import { DeploymentService, ProjectService, type ApiRepositories } from './services.js';

function parsed<T>(value: unknown, schema: { parse(input: unknown): T }): T {
  try {
    return schema.parse(value);
  } catch (error) {
    const fields =
      error &&
      typeof error === 'object' &&
      'issues' in error &&
      Array.isArray(error.issues)
        ? error.issues
            .map((issue: unknown) =>
              issue &&
              typeof issue === 'object' &&
              'path' in issue &&
              Array.isArray(issue.path)
                ? issue.path.join('.')
                : undefined,
            )
            .filter((field): field is string => Boolean(field))
        : undefined;
    throw new BadRequestError('request is invalid', fields);
  }
}

function projectResponse(project: Awaited<ReturnType<ProjectService['get']>>) {
  return {
    id: project.id,
    provider: project.provider,
    owner: project.owner,
    repository: project.repository,
    defaultBranch: project.defaultBranch,
    createdAt: new Date(project.createdAt).toISOString(),
    updatedAt: new Date(project.updatedAt).toISOString(),
  };
}

export interface DeploymentEventOptions {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxConnectionMs?: number;
  maxActiveStreams?: number;
  sessionRevalidationIntervalMs?: number;
  revalidateSession?: (request: Request) => Promise<boolean>;
}

export function createApiRouter(
  repositories: ApiRepositories,
  eventOptions: DeploymentEventOptions = {},
): Router {
  const router = express.Router();
  const projects = new ProjectService(repositories.projects);
  const deployments = new DeploymentService(
    repositories.deployments,
    repositories.projects,
  );
  let activeDeploymentStreams = 0;

  router.post('/projects', async (request, response) => {
    const input = parsed(request.body, createProjectSchema);
    const project = await projects.create(input);
    response.status(201).json({ project: projectResponse(project) });
  });

  router.get('/projects', async (request, response) => {
    const query = parsed(request.query, listQuerySchema);
    const page = await projects.list(query);
    response.json({
      projects: page.items.map(projectResponse),
      nextCursor: page.nextCursor,
    });
  });

  router.get('/projects/:projectId', async (request, response) => {
    const { projectId } = parsed(request.params, projectPathSchema);
    const project = await projects.get(projectId);
    response.json({ project: projectResponse(project) });
  });

  router.get('/projects/:projectId/deployments', async (request, response) => {
    const projectId = parsed(request.params.projectId, projectIdSchema);
    const query = parsed(request.query, listQuerySchema);
    const page = await deployments.listByProject(projectId, query);
    response.json({
      deployments: page.items.map(deploymentListResponse),
      nextCursor: page.nextCursor,
    });
  });

  router.get('/deployments/:deploymentId', async (request, response) => {
    const { deploymentId } = parsed(request.params, deploymentPathSchema);
    const deployment = await deployments.get(deploymentId);
    response.json({ deployment: deploymentDetailResponse(deployment) });
  });

  router.get('/deployments/:deploymentId/events', async (request, response) => {
    const { deploymentId } = parsed(request.params, deploymentPathSchema);
    if (activeDeploymentStreams >= (eventOptions.maxActiveStreams ?? 32)) {
      throw new ServiceUnavailableError('deployment streams are at capacity');
    }
    activeDeploymentStreams += 1;
    let released = false;
    const releaseSlot = () => {
      if (released) return;
      released = true;
      activeDeploymentStreams -= 1;
    };
    response.on('close', releaseSlot);

    // Resolve before sending headers so invalid or missing IDs retain JSON errors.
    let initial: Awaited<ReturnType<DeploymentService['get']>>;
    try {
      initial = await deployments.get(deploymentId);
    } catch (error) {
      releaseSlot();
      throw error;
    }
    if (response.destroyed) {
      releaseSlot();
      return;
    }

    try {
      response.status(200);
      response.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
    } catch (error) {
      releaseSlot();
      throw error;
    }

    let closed = false;
    let reading = false;
    let lastVersion = initial.version;
    const timers: {
      poll?: NodeJS.Timeout;
      heartbeat?: NodeJS.Timeout;
      lifetime?: NodeJS.Timeout;
      authorization?: NodeJS.Timeout;
    } = {};
    let authorizing = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timers.poll) clearInterval(timers.poll);
      if (timers.heartbeat) clearInterval(timers.heartbeat);
      if (timers.lifetime) clearTimeout(timers.lifetime);
      if (timers.authorization) clearInterval(timers.authorization);
      releaseSlot();
      response.end();
    };
    response.on('close', close);
    if (response.destroyed) {
      close();
      return;
    }

    const sendDeployment = (deployment: typeof initial) => {
      if (closed || response.destroyed) return;
      const data = JSON.stringify({ deployment: deploymentDetailResponse(deployment) });
      if (
        !response.write(
          `id: ${deployment.version}\nevent: deployment\ndata: ${data}\n\n`,
        )
      ) {
        // A slow reader must not accumulate an unbounded response buffer.
        close();
      }
    };

    sendDeployment(initial);
    if (closed) return;

    timers.poll = setInterval(() => {
      if (reading || closed) return;
      reading = true;
      void deployments
        .get(deploymentId)
        .then((current) => {
          if (closed || current.version <= lastVersion) return;
          lastVersion = current.version;
          sendDeployment(current);
        })
        .catch(() => {
          if (!closed && !response.destroyed) {
            const writable = response.write(
              'event: stream-error\ndata: {"message":"deployment stream unavailable"}\n\n',
            );
            if (!writable) {
              close();
              return;
            }
          }
          close();
        })
        .finally(() => {
          reading = false;
        });
    }, eventOptions.pollIntervalMs ?? 2_000);
    timers.poll.unref();

    timers.heartbeat = setInterval(() => {
      if (closed || response.destroyed) return;
      if (!response.write(': heartbeat\n\n')) close();
    }, eventOptions.heartbeatIntervalMs ?? 15_000);
    timers.heartbeat.unref();

    if (eventOptions.revalidateSession) {
      timers.authorization = setInterval(() => {
        if (closed || authorizing) return;
        authorizing = true;
        void eventOptions.revalidateSession!(request)
          .then((authorized) => {
            if (!authorized) close();
          })
          .catch(close)
          .finally(() => {
            authorizing = false;
          });
      }, eventOptions.sessionRevalidationIntervalMs ?? 15_000);
      timers.authorization.unref();
    }

    // EventSource reconnects with a fresh authoritative snapshot. This bounds
    // the lifetime of every individual polling connection.
    timers.lifetime = setTimeout(close, eventOptions.maxConnectionMs ?? 300_000);
    timers.lifetime.unref();
  });

  return router;
}
