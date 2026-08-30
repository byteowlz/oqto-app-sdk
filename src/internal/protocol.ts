import { OqtoAppError, type OqtoAppErrorCode } from "../errors.js";
import { OQTO_APP_PROTOCOL, type OqtoCapability, type OqtoFileRef, type OqtoHostContext } from "../types.js";

export const READY_KIND = "oqto.app.ready" as const;
export const CONNECT_KIND = "oqto.app.connect" as const;

export interface ReadyMessage {
  readonly protocol: typeof OQTO_APP_PROTOCOL;
  readonly kind: typeof READY_KIND;
  readonly nonce: string;
}

export interface ConnectMessage {
  readonly protocol: typeof OQTO_APP_PROTOCOL;
  readonly kind: typeof CONNECT_KIND;
  readonly nonce: string;
  readonly context: OqtoHostContext;
}

export interface RequestMessage {
  readonly protocol: typeof OQTO_APP_PROTOCOL;
  readonly kind: "request";
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

export interface ResultMessage {
  readonly protocol: typeof OQTO_APP_PROTOCOL;
  readonly kind: "result";
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: SerializedError;
}

export interface EventMessage {
  readonly protocol: typeof OQTO_APP_PROTOCOL;
  readonly kind: "event";
  readonly subscriptionId: string;
  readonly value: unknown;
}

export interface CloseMessage {
  readonly protocol: typeof OQTO_APP_PROTOCOL;
  readonly kind: "close";
  readonly reason: "app" | "host" | "transport";
}

export interface SerializedError {
  readonly code: OqtoAppErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, string>>;
}

const CAPABILITIES = new Set<OqtoCapability>(["files", "kv", "theme", "notifications"]);
const ERROR_CODES = new Set<OqtoAppErrorCode>([
  "cancelled",
  "denied",
  "disconnected",
  "gone",
  "internal",
  "invalid",
  "quota_exceeded",
  "timeout",
  "too_large",
  "unsupported",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isReadyMessage(value: unknown): value is ReadyMessage {
  return (
    isRecord(value) &&
    value.protocol === OQTO_APP_PROTOCOL &&
    value.kind === READY_KIND &&
    typeof value.nonce === "string" &&
    value.nonce.length > 0
  );
}

export function parseConnectMessage(value: unknown, nonce: string): ConnectMessage {
  if (
    !isRecord(value) ||
    value.protocol !== OQTO_APP_PROTOCOL ||
    value.kind !== CONNECT_KIND ||
    value.nonce !== nonce
  ) {
    throw new OqtoAppError("invalid", "Host returned an invalid Oqto App handshake");
  }
  return {
    protocol: OQTO_APP_PROTOCOL,
    kind: CONNECT_KIND,
    nonce,
    context: parseHostContext(value.context),
  };
}

export function parseHostContext(value: unknown): OqtoHostContext {
  if (!isRecord(value)) throw new OqtoAppError("invalid", "Host context must be an object");
  const { protocol, instanceId, installationId, definitionId, capabilities } = value;
  if (protocol !== OQTO_APP_PROTOCOL) throw new OqtoAppError("unsupported", "Unsupported host protocol");
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    throw new OqtoAppError("invalid", "Host context requires instanceId");
  }
  if (typeof installationId !== "string" || installationId.length === 0) {
    throw new OqtoAppError("invalid", "Host context requires installationId");
  }
  if (typeof definitionId !== "string" || definitionId.length === 0) {
    throw new OqtoAppError("invalid", "Host context requires definitionId");
  }
  if (!Array.isArray(capabilities) || !capabilities.every(isCapability)) {
    throw new OqtoAppError("invalid", "Host context contains invalid capabilities");
  }
  const base = {
    protocol: OQTO_APP_PROTOCOL,
    instanceId,
    installationId,
    definitionId,
    capabilities,
  } as const;
  if (value.bound === undefined) return base;
  if (!isRecord(value.bound)) throw new OqtoAppError("invalid", "Bound resource must be an object");
  const { ref, label, mediaType, access, role } = value.bound;
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    typeof label !== "string" ||
    typeof mediaType !== "string" ||
    (access !== "read" && access !== "readwrite") ||
    role !== "document"
  ) {
    throw new OqtoAppError("invalid", "Bound resource is invalid");
  }
  return { ...base, bound: { ref: ref as OqtoFileRef, label, mediaType, access, role } };
}

function isCapability(value: unknown): value is OqtoCapability {
  return typeof value === "string" && CAPABILITIES.has(value as OqtoCapability);
}

export function isRequestMessage(value: unknown): value is RequestMessage {
  return (
    isRecord(value) &&
    value.protocol === OQTO_APP_PROTOCOL &&
    value.kind === "request" &&
    Number.isSafeInteger(value.id) &&
    typeof value.method === "string" &&
    "params" in value
  );
}

export function isResultMessage(value: unknown): value is ResultMessage {
  return (
    isRecord(value) &&
    value.protocol === OQTO_APP_PROTOCOL &&
    value.kind === "result" &&
    Number.isSafeInteger(value.id) &&
    typeof value.ok === "boolean"
  );
}

export function isEventMessage(value: unknown): value is EventMessage {
  return (
    isRecord(value) &&
    value.protocol === OQTO_APP_PROTOCOL &&
    value.kind === "event" &&
    typeof value.subscriptionId === "string" &&
    "value" in value
  );
}

export function isCloseMessage(value: unknown): value is CloseMessage {
  return (
    isRecord(value) &&
    value.protocol === OQTO_APP_PROTOCOL &&
    value.kind === "close" &&
    (value.reason === "app" || value.reason === "host" || value.reason === "transport")
  );
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof OqtoAppError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  return { code: "internal", message: "Host operation failed" };
}

export function deserializeError(value: unknown): OqtoAppError {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    !ERROR_CODES.has(value.code as OqtoAppErrorCode)
  ) {
    return new OqtoAppError("internal", "Host returned an invalid error");
  }
  const message = typeof value.message === "string" ? value.message : "Host operation failed";
  const details = parseDetails(value.details);
  return details === undefined
    ? new OqtoAppError(value.code as OqtoAppErrorCode, message)
    : new OqtoAppError(value.code as OqtoAppErrorCode, message, { details });
}

function parseDetails(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every((entry) => typeof entry[1] === "string")) return undefined;
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}
