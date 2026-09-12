import { resolve } from 'node:path';

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

export type RuntimeEnvironment = z.infer<typeof commonEnvironmentSchema>;
export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;

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

export function loadAppEnvironment(cwd: string = process.cwd()): void {
  dotenv.config({ path: resolve(cwd, '.env'), quiet: true });
}
