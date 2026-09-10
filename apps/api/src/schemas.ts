import { z } from 'zod';

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

const identifier = z.string().uuid('invalid identifier');
const cursor = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid cursor');

export const projectIdSchema = identifier;
export const deploymentIdSchema = identifier;
export const projectPathSchema = z.object({ projectId: projectIdSchema }).strict();
export const deploymentPathSchema = z
  .object({ deploymentId: deploymentIdSchema })
  .strict();

export const createProjectSchema = z
  .object({
    owner: z
      .string()
      .trim()
      .min(1)
      .max(39)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/)
      .transform((value) => value.toLowerCase()),
    repository: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/)
      .transform((value) => value.toLowerCase()),
    defaultBranch: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !containsControlCharacter(value))
      .default('main'),
  })
  .strict();

export const listQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d+$/, 'limit must be an integer')
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .optional()
      .default(25),
    cursor: cursor.optional(),
  })
  .strict();

export const queuedDeploymentSchema = z
  .object({
    projectId: identifier,
    commitSha: z
      .string()
      .regex(/^[a-f\d]{40}$/i)
      .transform((value) => value.toLowerCase()),
  })
  .strict();

export const webhookMetadataSchema = z
  .object({
    deliveryId: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_-]+$/),
    eventName: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
    action: z.string().trim().min(1).max(100).optional(),
    metadata: z
      .record(z.string().min(1).max(100), z.string().max(500))
      .refine((value) => Object.keys(value).length <= 20)
      .optional(),
  })
  .strict();

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
export type QueuedDeploymentInput = z.infer<typeof queuedDeploymentSchema>;
export type WebhookMetadataInput = z.infer<typeof webhookMetadataSchema>;
