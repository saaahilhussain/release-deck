import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

const logLevels = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

function isRedisUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      ['redis:', 'rediss:'].includes(parsed.protocol) && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function isMongoUrl(value: string): boolean {
  const match = /^(mongodb(?:\+srv)?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value);
  if (!match) return false;
  const protocol = match[1]?.toLowerCase();
  const authority = match[2];
  if (!protocol || !authority) return false;

  const hosts = authority.slice(authority.lastIndexOf('@') + 1).split(',');
  if (protocol === 'mongodb+srv' && hosts.length !== 1) return false;
  return hosts.every((host) => {
    if (!host) return false;
    try {
      const parsed = new URL(`http://${host}`);
      return (
        parsed.hostname.length > 0 &&
        (protocol !== 'mongodb+srv' || parsed.port.length === 0)
      );
    } catch {
      return false;
    }
  });
}

const mongoUrl = z.string().min(1).refine(isMongoUrl);

const redisUrl = z.string().min(1).refine(isRedisUrl);

const commonEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  MONGODB_URI: mongoUrl,
  REDIS_URL: redisUrl,
});

const apiEnvironmentSchema = commonEnvironmentSchema.extend({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
});

const workerEnvironmentSchema = commonEnvironmentSchema
  .extend({
    CI_WORKSPACE_ROOT: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine(
        (value) =>
          ![...value].some(
            (character) =>
              character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
          ),
      )
      .refine(isAbsolute, 'must be an absolute path')
      .default(resolve(tmpdir(), 'releasedeck-workspaces')),
    CI_STEP_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(300_000),
    CI_TOTAL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(1_800_000),
    CI_MAX_OUTPUT_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(16_777_216)
      .default(1_048_576),
    CI_LEASE_MS: z.coerce
      .number()
      .int()
      .min(61_000)
      .max(172_800_000)
      .default(2_400_000),
    CI_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  })
  .superRefine((value, context) => {
    if (value.CI_TOTAL_TIMEOUT_MS < value.CI_STEP_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom',
        path: ['CI_TOTAL_TIMEOUT_MS'],
        message: 'must be at least CI_STEP_TIMEOUT_MS',
      });
    }
    if (value.CI_LEASE_MS < value.CI_TOTAL_TIMEOUT_MS + 60_000) {
      context.addIssue({
        code: 'custom',
        path: ['CI_LEASE_MS'],
        message: 'must exceed CI_TOTAL_TIMEOUT_MS by at least 60000ms',
      });
    }
  });

export type RuntimeEnvironment = z.infer<typeof commonEnvironmentSchema>;
export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;
export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;

export class ConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    const uniqueFields = [...new Set(fields)].sort();
    super(`Invalid environment configuration: ${uniqueFields.join(', ')}`);
    this.name = 'ConfigurationError';
    this.fields = uniqueFields;
  }
}

function parseWithSchema<T>(schema: z.ZodType<T>, input: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  // Only field names are exposed. Environment values may contain credentials.
  throw new ConfigurationError(
    result.error.issues.map((issue) => issue.path.join('.') || 'environment'),
  );
}

export function parseRuntimeEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): RuntimeEnvironment {
  return parseWithSchema(commonEnvironmentSchema, input);
}

export function parseApiEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): ApiEnvironment {
  return parseWithSchema(apiEnvironmentSchema, input);
}

export function parseWorkerEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): WorkerEnvironment {
  return parseWithSchema(workerEnvironmentSchema, input);
}

export function loadAppEnvironment(cwd: string = process.cwd()): void {
  dotenv.config({ path: resolve(cwd, '.env'), quiet: true });
}
