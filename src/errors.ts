export type OqtoAppErrorCode =
  | "cancelled"
  | "denied"
  | "disconnected"
  | "gone"
  | "internal"
  | "invalid"
  | "quota_exceeded"
  /** Authority was withdrawn while this mount was live. */
  | "suspended"
  | "timeout"
  | "too_large"
  | "unsupported";

/** Typed exceptional failure. Conditional-write conflicts are values, not exceptions. */
export class OqtoAppError extends Error {
  readonly code: OqtoAppErrorCode;
  readonly details?: Readonly<Record<string, string>>;

  constructor(
    code: OqtoAppErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly details?: Readonly<Record<string, string>> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OqtoAppError";
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function isOqtoAppError(value: unknown): value is OqtoAppError {
  return value instanceof OqtoAppError;
}
