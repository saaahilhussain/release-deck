import pino, { type Logger, type LoggerOptions } from 'pino';

const sensitiveKeyPaths = [
  'MONGODB_URI',
  'REDIS_URL',
  'GITHUB_WEBHOOK_SECRET',
  '*.MONGODB_URI',
  '*.REDIS_URL',
  '*.GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_JWT',
  'RELEASEDECK_CHECKOUT_TOKEN',
  'RELEASEDECK_CHECKOUT_PATH',
  '*.GITHUB_APP_ID',
  '*.GITHUB_APP_INSTALLATION_ID',
  '*.GITHUB_APP_PRIVATE_KEY_PATH',
  '*.GITHUB_APP_PRIVATE_KEY',
  '*.GITHUB_APP_JWT',
  '*.RELEASEDECK_CHECKOUT_TOKEN',
  '*.RELEASEDECK_CHECKOUT_PATH',
  'password',
  '*.password',
  'token',
  '*.token',
  'authorization',
  '*.authorization',
];

const safeDependencies = new Set(['mongodb', 'redis', 'http']);

function safeErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const rawCode = 'code' in error ? error.code : undefined;
  return typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(rawCode)
    ? rawCode
    : undefined;
}

export class DependencyError extends Error {
  readonly dependency: 'mongodb' | 'redis' | 'http';
  readonly code: string | undefined;

  constructor(dependency: 'mongodb' | 'redis' | 'http', cause: unknown) {
    super(`${dependency} dependency unavailable`);
    this.name = 'DependencyError';
    this.dependency = dependency;
    this.code = safeErrorCode(cause);
  }
}

export function errorForLog(error: unknown): {
  name: string;
  code?: string;
  dependency?: string;
  fields?: readonly string[];
} {
  if (!(error instanceof Error)) {
    return { name: 'Error' };
  }

  const fields =
    'fields' in error && Array.isArray(error.fields)
      ? error.fields.filter((field): field is string => typeof field === 'string')
      : undefined;
  const code = safeErrorCode(error);
  const rawDependency = 'dependency' in error ? error.dependency : undefined;
  const dependency =
    typeof rawDependency === 'string' && safeDependencies.has(rawDependency)
      ? rawDependency
      : undefined;
  return {
    name: error.name,
    ...(code ? { code } : {}),
    ...(dependency ? { dependency } : {}),
    ...(fields ? { fields } : {}),
  };
}

export function createLogger(level: LoggerOptions['level'] = 'info'): Logger {
  return pino({
    level,
    redact: {
      paths: sensitiveKeyPaths,
      censor: '[Redacted]',
    },
    base: null,
  });
}
