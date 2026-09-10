import { InvalidCursorError, ValidationError } from './errors.js';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface PageOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Omitted by callers that have reached the end; repositories return null. */
  readonly nextCursor?: string | null;
}

export interface CursorPosition {
  readonly createdAt: Date;
  readonly id: string;
}

export function pageSize(options: PageOptions = {}): number {
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ValidationError('page size must be between 1 and 100');
  }
  return limit;
}

export function encodeCursor(position: CursorPosition): string {
  if (
    !(position.createdAt instanceof Date) ||
    Number.isNaN(position.createdAt.valueOf())
  ) {
    throw new InvalidCursorError();
  }
  if (!position.id) throw new InvalidCursorError();
  const payload = JSON.stringify({
    at: position.createdAt.toISOString(),
    id: position.id,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    if (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error('invalid cursor');
    }
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (!value || typeof value !== 'object') throw new Error('invalid cursor');
    const record = value as Record<string, unknown>;
    if (typeof record.at !== 'string' || typeof record.id !== 'string' || !record.id) {
      throw new Error('invalid cursor');
    }
    const createdAt = new Date(record.at);
    if (Number.isNaN(createdAt.valueOf())) throw new Error('invalid cursor');
    return { createdAt, id: record.id };
  } catch {
    throw new InvalidCursorError();
  }
}
