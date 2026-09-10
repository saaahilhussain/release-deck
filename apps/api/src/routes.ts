import type { Router } from 'express';
import express from 'express';
import { BadRequestError } from './errors.js';
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

function deploymentResponse(deployment: Awaited<ReturnType<DeploymentService['get']>>) {
  return {
    id: deployment.id,
    projectId: deployment.projectId,
    provider: deployment.provider,
    commitSha: deployment.commitSha,
    status: deployment.status,
    stage: deployment.stage,
    version: deployment.version,
    createdAt: new Date(deployment.createdAt).toISOString(),
    updatedAt: new Date(deployment.updatedAt).toISOString(),
  };
}

export function createApiRouter(repositories: ApiRepositories): Router {
  const router = express.Router();
  const projects = new ProjectService(repositories.projects);
  const deployments = new DeploymentService(
    repositories.deployments,
    repositories.projects,
  );

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
      deployments: page.items.map(deploymentResponse),
      nextCursor: page.nextCursor,
    });
  });

  router.get('/deployments/:deploymentId', async (request, response) => {
    const { deploymentId } = parsed(request.params, deploymentPathSchema);
    const deployment = await deployments.get(deploymentId);
    response.json({ deployment: deploymentResponse(deployment) });
  });

  return router;
}
