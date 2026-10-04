/**
 * Typed API errors. HTTP responses never include stack traces.
 * Production responses for non-exposed errors use a generic message.
 */

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly expose: boolean;
  readonly fields: readonly string[] | undefined;
  readonly details: unknown;

  constructor(
    code: string,
    status: number,
    message: string,
    options?: { expose?: boolean; fields?: readonly string[]; details?: unknown },
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.expose = options?.expose ?? status < 500;
    this.fields = options?.fields;
    this.details = options?.details;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class IllegalTransitionError extends AppError {
  readonly entity: string;
  readonly from: string;
  readonly to: string;

  constructor(entity: string, from: string, to: string) {
    super(
      "ILLEGAL_TRANSITION",
      409,
      `Illegal ${entity} transition from ${from} to ${to}`,
    );
    this.name = "IllegalTransitionError";
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export interface PublicErrorBody {
  error: {
    code: string;
    message: string;
    correlationId: string;
    fields?: readonly string[];
    details?: unknown;
  };
}

/**
 * Map an exception to a client-safe body.
 * Stack traces are never included. In production, unexpected errors and
 * non-exposed AppErrors do not reveal their message.
 */
export function toPublicError(
  err: unknown,
  nodeEnv: string,
  correlationId: string,
): { status: number; body: PublicErrorBody } {
  if (err instanceof AppError) {
    const hide = nodeEnv === "production" && !err.expose;
    const body: PublicErrorBody = {
      error: {
        code: hide ? "INTERNAL" : err.code,
        message: hide ? "Internal error" : err.message,
        correlationId,
      },
    };
    if (!hide && err.fields && err.fields.length > 0) {
      body.error.fields = err.fields;
    }
    if (!hide && err.details !== undefined) {
      body.error.details = err.details;
    }
    return { status: hide ? 500 : err.status, body };
  }

  const body: PublicErrorBody = {
    error: {
      code: "INTERNAL",
      message: "Internal error",
      correlationId,
    },
  };
  return { status: 500, body };
}
