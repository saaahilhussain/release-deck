export type ReleaseDeployerErrorKind =
  'preparation' | 'transport' | 'remote' | 'cleanup';

export interface ReleaseDeployerErrorOptions {
  readonly cause?: unknown;
  readonly exitCode?: number;
  readonly signal?: string;
}

export class ReleaseDeployerError extends Error {
  readonly kind: ReleaseDeployerErrorKind;
  readonly exitCode: number | undefined;
  readonly signal: string | undefined;

  constructor(
    kind: ReleaseDeployerErrorKind,
    message: string,
    options: ReleaseDeployerErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ReleaseDeployerError';
    this.kind = kind;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
  }
}
