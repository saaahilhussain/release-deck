/** Errors exposed by the persistence boundary.  Messages intentionally contain
 * no driver or query details so they are safe to map at an HTTP boundary. */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends DomainError {
  constructor(message = 'invalid domain input') {
    super('VALIDATION_ERROR', message);
  }
}

export class DuplicateError extends DomainError {
  constructor(message = 'record already exists') {
    super('DUPLICATE', message);
  }
}

export class NotFoundError extends DomainError {
  constructor(message = 'record not found') {
    super('NOT_FOUND', message);
  }
}

export class ConcurrencyError extends DomainError {
  constructor(message = 'record was changed by another operation') {
    super('CONCURRENCY', message);
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(message = 'deployment transition is not allowed') {
    super('INVALID_TRANSITION', message);
  }
}

export class InvalidCursorError extends DomainError {
  constructor() {
    super('INVALID_CURSOR', 'invalid pagination cursor');
  }
}

export class PersistenceError extends DomainError {
  constructor() {
    super('PERSISTENCE_ERROR', 'database operation failed');
  }
}
