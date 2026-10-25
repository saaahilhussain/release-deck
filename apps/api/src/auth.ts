import {
  createHash,
  randomBytes as cryptoRandomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import type { Request, RequestHandler, Router } from 'express';
import express from 'express';

import type { RedisConnection } from '@releasedeck/runtime';

import {
  ForbiddenError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
} from './errors.js';

const SCRYPT_N = 65_536;
const SCRYPT_R = 8;
const SCRYPT_P = 2;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_SALT_BYTES = 16;
const SESSION_ID_BYTES = 32;
const CSRF_BYTES = 32;
const IDLE_MS = 30 * 60 * 1_000;
const ABSOLUTE_MS = 8 * 60 * 60 * 1_000;
const RATE_WINDOW_MS = 15 * 60 * 1_000;
const ACCOUNT_FAILURE_LIMIT = 5;
const IP_FAILURE_LIMIT = 20;
const SESSION_PREFIX = 'releasedeck:auth:v1:session:';
const RATE_PREFIX = 'releasedeck:auth:v1:rate:';
const CSRF_HEADER = 'x-releasedeck-csrf';

const RATE_RESERVATION_SCRIPT = `
local account = tonumber(redis.call('GET', KEYS[1]) or '0')
local ip = tonumber(redis.call('GET', KEYS[2]) or '0')
if account >= tonumber(ARGV[2]) or ip >= tonumber(ARGV[3]) then
  return {0, account, ip, redis.call('PTTL', KEYS[1]), redis.call('PTTL', KEYS[2])}
end
account = redis.call('INCR', KEYS[1])
ip = redis.call('INCR', KEYS[2])
if account == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if ip == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
return {1, account, ip, redis.call('PTTL', KEYS[1]), redis.call('PTTL', KEYS[2])}
`;

const RATE_RELEASE_SCRIPT = `
for _, key in ipairs(KEYS) do
  local count = tonumber(redis.call('GET', key) or '0')
  if count <= 1 then
    redis.call('DEL', key)
  else
    redis.call('DECR', key)
  end
end
return 1
`;

type AuthRedis = RedisConnection['client'];

interface ParsedPasswordHash {
  readonly salt: Buffer;
  readonly derivedKey: Buffer;
}

interface StoredSession {
  readonly version: 1;
  readonly operatorId: string;
  readonly role: 'operator' | string;
  readonly credentialVersion: string;
  readonly csrfToken: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly absoluteExpiresAt: number;
}

export interface AuthenticatedOperator {
  readonly operatorId: string;
  readonly role: 'operator';
  readonly csrfToken: string;
  readonly absoluteExpiresAt: number;
  readonly idleExpiresAt: number;
}

type PasswordVerifier = (
  password: string,
  configured: ParsedPasswordHash,
) => Promise<boolean>;

export interface OperatorAuthOptions {
  readonly redis: AuthRedis;
  readonly operatorId: string;
  readonly passwordHash: string;
  readonly allowedOrigin: string;
  readonly secureCookies: boolean;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly passwordVerifier?: PasswordVerifier;
  readonly maxConcurrentPasswordVerifications?: number;
}

export interface OperatorAuthBoundary {
  readonly router: Router;
  readonly requireOperator: RequestHandler;
  readonly requireCsrfForMutation: RequestHandler;
  revalidate(request: Request): Promise<boolean>;
}

type LoadResult =
  | { readonly kind: 'missing' | 'invalid' }
  | { readonly kind: 'forbidden' }
  | {
      readonly kind: 'valid';
      readonly key: string;
      readonly session: StoredSession;
      readonly operator: AuthenticatedOperator;
    };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}

export function parseOperatorPasswordHash(value: string): ParsedPasswordHash {
  const parts = value.split('$');
  if (
    parts.length !== 5 ||
    parts[0] !== 'scrypt' ||
    parts[1] !== 'v1' ||
    parts[2] !== `N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`
  ) {
    throw new Error('operator password hash configuration is invalid');
  }
  const salt = decodeCanonicalBase64Url(parts[3] ?? '');
  const derivedKey = decodeCanonicalBase64Url(parts[4] ?? '');
  if (salt?.length !== SCRYPT_SALT_BYTES || derivedKey?.length !== SCRYPT_KEY_BYTES) {
    throw new Error('operator password hash configuration is invalid');
  }
  return { salt, derivedKey };
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

async function verifyPassword(
  password: string,
  configured: ParsedPasswordHash,
): Promise<boolean> {
  const candidate = await derivePassword(password, configured.salt);
  return timingSafeEqual(candidate, configured.derivedKey);
}

export async function hashOperatorPassword(
  password: string,
  randomBytes: (size: number) => Buffer = cryptoRandomBytes,
): Promise<string> {
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < 16 || bytes > 1_024) {
    throw new Error('operator password must contain between 16 and 1024 UTF-8 bytes');
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  if (salt.length !== SCRYPT_SALT_BYTES) throw new Error('invalid random salt');
  const derivedKey = await derivePassword(password, salt);
  return [
    'scrypt',
    'v1',
    `N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
}

function parseCookies(header: string | undefined): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value && !values.has(name)) values.set(name, value);
  }
  return values;
}

function validToken(value: string | undefined): value is string {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return decodeCanonicalBase64Url(value)?.length === SESSION_ID_BYTES;
}

function parseStoredSession(value: string): StoredSession | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredSession>;
    if (
      parsed.version !== 1 ||
      typeof parsed.operatorId !== 'string' ||
      typeof parsed.role !== 'string' ||
      typeof parsed.credentialVersion !== 'string' ||
      typeof parsed.csrfToken !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.lastSeenAt !== 'number' ||
      typeof parsed.absoluteExpiresAt !== 'number' ||
      !Number.isSafeInteger(parsed.createdAt) ||
      !Number.isSafeInteger(parsed.lastSeenAt) ||
      !Number.isSafeInteger(parsed.absoluteExpiresAt) ||
      !validToken(parsed.csrfToken)
    ) {
      return null;
    }
    return parsed as StoredSession;
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function directPeer(request: Request): string {
  return request.socket.remoteAddress || 'unknown';
}

export function createOperatorAuth(options: OperatorAuthOptions): OperatorAuthBoundary {
  const configuredHash = parseOperatorPasswordHash(options.passwordHash);
  const credentialVersion = sha256(`${options.operatorId}\0${options.passwordHash}`);
  const cookieName = options.secureCookies
    ? '__Host-releasedeck_session'
    : 'releasedeck_session_dev';
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  const passwordVerifier = options.passwordVerifier ?? verifyPassword;
  const maxConcurrent = options.maxConcurrentPasswordVerifications ?? 2;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
    throw new Error('password verification concurrency is invalid');
  }
  let activePasswordVerifications = 0;

  const sessionKey = (token: string) => `${SESSION_PREFIX}${sha256(token)}`;
  const rateKeys = (request: Request) => ({
    account: `${RATE_PREFIX}account:${credentialVersion}`,
    ip: `${RATE_PREFIX}ip:${sha256(directPeer(request))}`,
  });
  const setCookie = (token: string) =>
    [
      `${cookieName}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(ABSOLUTE_MS / 1_000)}`,
      ...(options.secureCookies ? ['Secure'] : []),
    ].join('; ');
  const clearCookie = () =>
    [
      `${cookieName}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ...(options.secureCookies ? ['Secure'] : []),
    ].join('; ');

  const assertOrigin = (request: Request) => {
    if (request.get('origin') !== options.allowedOrigin) {
      throw new ForbiddenError('request origin is not allowed');
    }
  };

  const loadSession = async (request: Request, renew: boolean): Promise<LoadResult> => {
    const token = parseCookies(request.get('cookie'))?.get(cookieName);
    if (!validToken(token)) return { kind: 'missing' };
    const key = sessionKey(token);
    let encoded: string | null;
    try {
      encoded = await options.redis.get(key);
    } catch {
      throw new ServiceUnavailableError('authentication service is unavailable');
    }
    if (!encoded) return { kind: 'invalid' };
    const session = parseStoredSession(encoded);
    const current = now();
    if (
      !session ||
      session.operatorId !== options.operatorId ||
      session.credentialVersion !== credentialVersion ||
      current >= session.absoluteExpiresAt ||
      current - session.lastSeenAt >= IDLE_MS
    ) {
      await options.redis.del(key).catch(() => undefined);
      return { kind: 'invalid' };
    }
    if (session.role !== 'operator') return { kind: 'forbidden' };
    const updated = renew ? { ...session, lastSeenAt: current } : session;
    if (renew) {
      const ttl = Math.min(IDLE_MS, updated.absoluteExpiresAt - current);
      let stored: unknown;
      try {
        stored = await options.redis.set(key, JSON.stringify(updated), 'PX', ttl, 'XX');
      } catch {
        throw new ServiceUnavailableError('authentication service is unavailable');
      }
      if (stored !== 'OK') return { kind: 'invalid' };
    }
    return {
      kind: 'valid',
      key,
      session: updated,
      operator: {
        operatorId: updated.operatorId,
        role: 'operator',
        csrfToken: updated.csrfToken,
        absoluteExpiresAt: updated.absoluteExpiresAt,
        idleExpiresAt: Math.min(
          updated.lastSeenAt + IDLE_MS,
          updated.absoluteExpiresAt,
        ),
      },
    };
  };

  const requireOperator: RequestHandler = async (request, response, next) => {
    try {
      const loaded = await loadSession(request, true);
      if (loaded.kind === 'forbidden') throw new ForbiddenError();
      if (loaded.kind !== 'valid') {
        if (request.get('cookie')?.includes(`${cookieName}=`)) {
          response.setHeader('Set-Cookie', clearCookie());
        }
        throw new UnauthorizedError('operator authentication is required');
      }
      response.locals.operator = loaded.operator;
      response.locals.operatorSessionKey = loaded.key;
      next();
    } catch (error) {
      next(error);
    }
  };

  const requireCsrfForMutation: RequestHandler = (request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      next();
      return;
    }
    try {
      assertOrigin(request);
      const operator = response.locals.operator as AuthenticatedOperator | undefined;
      const supplied = request.get(CSRF_HEADER);
      if (!operator || !supplied || !safeEqual(supplied, operator.csrfToken)) {
        throw new ForbiddenError('CSRF validation failed');
      }
      next();
    } catch (error) {
      next(error);
    }
  };

  const reserveRateLimit = async (request: Request) => {
    const keys = rateKeys(request);
    try {
      const result = await options.redis.eval(
        RATE_RESERVATION_SCRIPT,
        2,
        keys.account,
        keys.ip,
        String(RATE_WINDOW_MS),
        String(ACCOUNT_FAILURE_LIMIT),
        String(IP_FAILURE_LIMIT),
      );
      if (!Array.isArray(result) || result.length !== 5) {
        throw new Error('invalid rate limit response');
      }
      const [allowed, accountCount, ipCount, accountTtl, ipTtl] = result.map(
        Number,
      ) as [number, number, number, number, number];
      if (!allowed) {
        const ttl = Math.max(
          accountCount >= ACCOUNT_FAILURE_LIMIT ? accountTtl : 0,
          ipCount >= IP_FAILURE_LIMIT ? ipTtl : 0,
        );
        throw new TooManyRequestsError(Math.max(1, Math.ceil(ttl / 1_000)));
      }
      return keys;
    } catch (error) {
      if (error instanceof TooManyRequestsError) throw error;
      throw new ServiceUnavailableError('authentication service is unavailable');
    }
  };

  const router = express.Router();
  router.post('/login', async (request, response) => {
    assertOrigin(request);
    if (activePasswordVerifications >= maxConcurrent) {
      response.setHeader('Retry-After', '1');
      throw new ServiceUnavailableError('authentication service is busy');
    }
    activePasswordVerifications += 1;
    let keys: { account: string; ip: string };
    const body = request.body as Record<string, unknown> | undefined;
    const submittedId = body?.operatorId;
    const submittedPassword = body?.password;
    const structurallyValid =
      body !== null &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      Object.keys(body).length === 2 &&
      typeof submittedId === 'string' &&
      typeof submittedPassword === 'string' &&
      Buffer.byteLength(submittedPassword, 'utf8') <= 1_024;
    let passwordMatches: boolean;
    try {
      keys = await reserveRateLimit(request);
      passwordMatches = await passwordVerifier(
        structurallyValid ? submittedPassword : '',
        configuredHash,
      );
    } finally {
      activePasswordVerifications -= 1;
    }
    const valid =
      structurallyValid &&
      safeEqual(submittedId, options.operatorId) &&
      passwordMatches;
    if (!valid) {
      throw new UnauthorizedError('operator authentication failed');
    }
    try {
      await options.redis.eval(RATE_RELEASE_SCRIPT, 2, keys.account, keys.ip);
      const token = randomBytes(SESSION_ID_BYTES).toString('base64url');
      const csrfToken = randomBytes(CSRF_BYTES).toString('base64url');
      const createdAt = now();
      const session: StoredSession = {
        version: 1,
        operatorId: options.operatorId,
        role: 'operator',
        credentialVersion,
        csrfToken,
        createdAt,
        lastSeenAt: createdAt,
        absoluteExpiresAt: createdAt + ABSOLUTE_MS,
      };
      const stored = await options.redis.set(
        sessionKey(token),
        JSON.stringify(session),
        'PX',
        IDLE_MS,
        'NX',
      );
      if (stored !== 'OK') {
        throw new ServiceUnavailableError('authentication service is unavailable');
      }
      response.set({
        'Cache-Control': 'no-store',
        'Set-Cookie': setCookie(token),
      });
      response.status(204).end();
    } catch (error) {
      if (error instanceof ServiceUnavailableError) throw error;
      throw new ServiceUnavailableError('authentication service is unavailable');
    }
  });

  router.get('/session', requireOperator, (_request, response) => {
    const operator = response.locals.operator as AuthenticatedOperator;
    response.set('Cache-Control', 'no-store').json({
      operator: { id: operator.operatorId, role: operator.role },
      csrfToken: operator.csrfToken,
      absoluteExpiresAt: new Date(operator.absoluteExpiresAt).toISOString(),
      idleExpiresAt: new Date(operator.idleExpiresAt).toISOString(),
    });
  });

  router.post(
    '/logout',
    requireOperator,
    requireCsrfForMutation,
    async (_request, response) => {
      const key = response.locals.operatorSessionKey as string;
      try {
        await options.redis.del(key);
      } catch {
        throw new ServiceUnavailableError('authentication service is unavailable');
      }
      response.set({
        'Cache-Control': 'no-store',
        'Set-Cookie': clearCookie(),
      });
      response.status(204).end();
    },
  );

  return {
    router,
    requireOperator,
    requireCsrfForMutation,
    async revalidate(request) {
      try {
        return (await loadSession(request, true)).kind === 'valid';
      } catch {
        return false;
      }
    },
  };
}

export const AUTH_CONSTANTS = {
  accountFailureLimit: ACCOUNT_FAILURE_LIMIT,
  ipFailureLimit: IP_FAILURE_LIMIT,
  rateWindowMs: RATE_WINDOW_MS,
  idleMs: IDLE_MS,
  absoluteMs: ABSOLUTE_MS,
  csrfHeader: CSRF_HEADER,
  secureCookieName: '__Host-releasedeck_session',
  developmentCookieName: 'releasedeck_session_dev',
} as const;
