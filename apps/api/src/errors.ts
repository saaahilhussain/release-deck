export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'TOO_MANY_REQUESTS'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fields: readonly string[] | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    fields?: readonly string[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export class BadRequestError extends ApiError {
  constructor(message = 'request is invalid', fields?: readonly string[]) {
    super(400, 'BAD_REQUEST', message, fields);
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'webhook authentication failed') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'operator authorization is required') {
    super(403, 'FORBIDDEN', message);
    this.name = 'ForbiddenError';
  }
}

export class TooManyRequestsError extends ApiError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(429, 'TOO_MANY_REQUESTS', 'authentication temporarily unavailable');
    this.name = 'TooManyRequestsError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class UnsupportedMediaTypeError extends ApiError {
  constructor() {
    super(415, 'UNSUPPORTED_MEDIA_TYPE', 'content type must be application/json');
    this.name = 'UnsupportedMediaTypeError';
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'resource was not found') {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ApiError {
  constructor(message = 'resource conflicts with an existing record') {
    super(409, 'CONFLICT', message);
    this.name = 'ConflictError';
  }
}

export class PayloadTooLargeError extends ApiError {
  constructor() {
    super(413, 'PAYLOAD_TOO_LARGE', 'request body is too large');
    this.name = 'PayloadTooLargeError';
  }
}

export class ServiceUnavailableError extends ApiError {
  constructor(message = 'service is temporarily unavailable') {
    super(503, 'SERVICE_UNAVAILABLE', message);
    this.name = 'ServiceUnavailableError';
  }
}

export function isDuplicateError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; codeName?: unknown; name?: unknown };
  return (
    candidate.code === 11000 ||
    candidate.code === 'DUPLICATE_KEY' ||
    candidate.code === 'DUPLICATE' ||
    candidate.codeName === 'DuplicateKey' ||
    candidate.name === 'DuplicateKeyError'
  );
}

export function isInvalidInputError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return (
    candidate.code === 'VALIDATION_ERROR' ||
    candidate.code === 'INVALID_CURSOR' ||
    candidate.name === 'ValidationError' ||
    candidate.name === 'InvalidCursorError'
  );
}

export function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.code === 'NOT_FOUND' || candidate.name === 'NotFoundError';
}
