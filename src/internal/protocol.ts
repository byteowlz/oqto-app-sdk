import { OqtoAppError, type OqtoAppErrorCode } from "../errors.js";
import {
  OQTO_APP_PROTOCOL,
  OQTO_APP_PROTOCOL_V1,
  OQTO_APP_PROTOCOL_V2,
  OQTO_APP_PROTOCOL_VERSIONS,
  type OqtoCapability,
  type OqtoFileRef,
  type OqtoGrantedOperation,
  type OqtoGrantedResource,
  type OqtoGrantSnapshot,
  type OqtoHostContext,
  type OqtoPresentationContext,
  type OqtoProtocolVersion,
  type OqtoResourceAccess,
  type OqtoResourceKind,
  type OqtoSuspension,
  type OqtoSuspensionReason,
} from "../types.js";

export const READY_KIND = "oqto.app.ready" as const;
export const CONNECT_KIND = "oqto.app.connect" as const;
export const SUSPEND_KIND = "suspend" as const;

const MAX_GRANTED_RESOURCES = 64;
const MAX_GRANTED_OPERATIONS = 128;
const MAX_ID_LENGTH = 512;
const MAX_LABEL_LENGTH = 512;
const MAX_SUMMARY_LENGTH = 512;
const MAX_MESSAGE_LENGTH = 4096;

export interface ReadyMessage {
  /** Always the v0 tag so hosts predating negotiation still recognize it. */
  readonly protocol: typeof OQTO_APP_PROTOCOL;
  readonly kind: typeof READY_KIND;
  readonly nonce: string;
  /** Versions the App accepts, newest first. Ignored by v0 hosts. */
  readonly supportedVersions: readonly OqtoProtocolVersion[];
}

export interface ConnectMessage {
  /** The version the host selected; all later frames must use it. */
  readonly protocol: OqtoProtocolVersion;
  readonly kind: typeof CONNECT_KIND;
  readonly nonce: string;
  readonly context: OqtoHostContext;
}

export interface RequestMessage {
  readonly protocol: OqtoProtocolVersion;
  readonly kind: "request";
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

export interface ResultMessage {
  readonly protocol: OqtoProtocolVersion;
  readonly kind: "result";
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: SerializedError;
}

export interface EventMessage {
  readonly protocol: OqtoProtocolVersion;
  readonly kind: "event";
  readonly subscriptionId: string;
  readonly value: unknown;
}

export interface CloseMessage {
  readonly protocol: OqtoProtocolVersion;
  readonly kind: "close";
  readonly reason: "app" | "host" | "transport";
}

export interface SuspendMessage {
  readonly protocol: OqtoProtocolVersion;
  readonly kind: typeof SUSPEND_KIND;
  readonly reason: OqtoSuspensionReason;
  readonly message?: string;
}

export interface SerializedError {
  readonly code: OqtoAppErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, string>>;
}

const CAPABILITIES = new Set<OqtoCapability>([
  "files",
  "kv",
  "theme",
  "notifications",
  "operations",
  "presentation",
  "agent_context",
]);
const ERROR_CODES = new Set<OqtoAppErrorCode>([
  "cancelled",
  "denied",
  "disconnected",
  "gone",
  "internal",
  "invalid",
  "quota_exceeded",
  "suspended",
  "timeout",
  "too_large",
  "unsupported",
]);
const SUSPENSION_REASONS = new Set<OqtoSuspensionReason>([
  "revoked",
  "suspended",
  "uninstalled",
  "definition_changed",
]);
const SURFACES = new Set(["inline", "container", "fullscreen", "window"]);
const SIZE_CLASSES = new Set(["compact", "regular", "expanded"]);
const DENSITIES = new Set(["comfortable", "compact"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProtocolVersion(value: unknown): value is OqtoProtocolVersion {
  return typeof value === "string" && (OQTO_APP_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

/** True when the negotiated version includes the v1 capability surface. */
export function supportsV1(protocol: OqtoProtocolVersion): boolean {
  return protocol === OQTO_APP_PROTOCOL_V1 || protocol === OQTO_APP_PROTOCOL_V2;
}

/** True when the negotiated version includes App-defined Agent Context. */
export function supportsV2(protocol: OqtoProtocolVersion): boolean {
  return protocol === OQTO_APP_PROTOCOL_V2;
}

export function isReadyMessage(value: unknown): value is ReadyMessage {
  return (
    isRecord(value) &&
    value.protocol === OQTO_APP_PROTOCOL &&
    value.kind === READY_KIND &&
    typeof value.nonce === "string" &&
    value.nonce.length > 0 &&
    value.nonce.length <= MAX_ID_LENGTH
  );
}

/**
 * Versions an App offered, newest first.
 *
 * A v0 App sends no offer, which is read as "v0 only" rather than as an error.
 */
export function readSupportedVersions(value: ReadyMessage | unknown): readonly OqtoProtocolVersion[] {
  if (!isRecord(value) || !Array.isArray(value.supportedVersions)) return [OQTO_APP_PROTOCOL];
  const offered = value.supportedVersions.filter(isProtocolVersion);
  return offered.length === 0 ? [OQTO_APP_PROTOCOL] : offered;
}

/** Pick the newest version both sides accept. */
export function negotiateProtocol(
  offered: readonly OqtoProtocolVersion[],
  supported: readonly OqtoProtocolVersion[] = OQTO_APP_PROTOCOL_VERSIONS,
): OqtoProtocolVersion | undefined {
  for (const candidate of supported) {
    if (offered.includes(candidate)) return candidate;
  }
  return undefined;
}

export function parseConnectMessage(
  value: unknown,
  nonce: string,
  offered: readonly OqtoProtocolVersion[],
): ConnectMessage {
  if (!isRecord(value) || value.kind !== CONNECT_KIND || value.nonce !== nonce) {
    throw new OqtoAppError("invalid", "Host returned an invalid Oqto App handshake");
  }
  if (!isProtocolVersion(value.protocol)) {
    throw new OqtoAppError("unsupported", "Host selected an unknown Oqto App protocol version");
  }
  if (!offered.includes(value.protocol)) {
    throw new OqtoAppError("unsupported", "Host selected a protocol version this App did not offer");
  }
  return {
    protocol: value.protocol,
    kind: CONNECT_KIND,
    nonce,
    context: parseHostContext(value.context, value.protocol),
  };
}

export function parseHostContext(value: unknown, expected?: OqtoProtocolVersion): OqtoHostContext {
  if (!isRecord(value)) throw new OqtoAppError("invalid", "Host context must be an object");
  const { protocol, instanceId, installationId, definitionId, capabilities } = value;
  if (!isProtocolVersion(protocol)) throw new OqtoAppError("unsupported", "Unsupported host protocol");
  if (expected !== undefined && protocol !== expected) {
    throw new OqtoAppError("invalid", "Host context protocol disagrees with the negotiated version");
  }
  if (typeof instanceId !== "string" || instanceId.length === 0 || instanceId.length > MAX_ID_LENGTH) {
    throw new OqtoAppError("invalid", "Host context requires instanceId");
  }
  if (
    typeof installationId !== "string" ||
    installationId.length === 0 ||
    installationId.length > MAX_ID_LENGTH
  ) {
    throw new OqtoAppError("invalid", "Host context requires installationId");
  }
  if (typeof definitionId !== "string" || definitionId.length === 0 || definitionId.length > MAX_ID_LENGTH) {
    throw new OqtoAppError("invalid", "Host context requires definitionId");
  }
  if (!Array.isArray(capabilities) || !capabilities.every(isCapability)) {
    throw new OqtoAppError("invalid", "Host context contains invalid capabilities");
  }

  const base = {
    protocol,
    instanceId,
    installationId,
    definitionId,
    capabilities,
    grants: parseGrants(value.grants, capabilities),
  } as const;

  const bound = parseBound(value.bound);
  const presentation = value.presentation === undefined ? undefined : parsePresentation(value.presentation);
  return {
    ...base,
    ...(bound === undefined ? {} : { bound }),
    ...(presentation === undefined ? {} : { presentation }),
  };
}

function parseBound(value: unknown): OqtoHostContext["bound"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new OqtoAppError("invalid", "Bound resource must be an object");
  const { ref, label, mediaType, access, role } = value;
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    typeof label !== "string" ||
    typeof mediaType !== "string" ||
    !isAccess(access) ||
    role !== "document"
  ) {
    throw new OqtoAppError("invalid", "Bound resource is invalid");
  }
  return { ref: ref as OqtoFileRef, label, mediaType, access, role };
}

/**
 * A v0 host sends no grant detail, so the snapshot degrades to the capability
 * list with empty resource and operation sets rather than failing the mount.
 */
function parseGrants(value: unknown, capabilities: readonly OqtoCapability[]): OqtoGrantSnapshot {
  if (value === undefined) return { capabilities, resources: [], operations: [] };
  if (!isRecord(value)) throw new OqtoAppError("invalid", "Grant snapshot must be an object");

  const resources = value.resources;
  const operations = value.operations;
  if (resources !== undefined && (!Array.isArray(resources) || resources.length > MAX_GRANTED_RESOURCES)) {
    throw new OqtoAppError("invalid", "Grant snapshot contains an invalid resource list");
  }
  if (
    operations !== undefined &&
    (!Array.isArray(operations) || operations.length > MAX_GRANTED_OPERATIONS)
  ) {
    throw new OqtoAppError("invalid", "Grant snapshot contains an invalid operation list");
  }
  return {
    capabilities,
    resources: resources === undefined ? [] : resources.map(parseGrantedResource),
    operations: operations === undefined ? [] : operations.map(parseGrantedOperation),
  };
}

export function parseGrantedResource(value: unknown): OqtoGrantedResource {
  if (!isRecord(value)) throw new OqtoAppError("invalid", "Granted resource must be an object");
  const { role, ref, label, mediaType, access, kind, watch } = value;
  if (
    typeof role !== "string" ||
    role.length === 0 ||
    role.length > MAX_LABEL_LENGTH ||
    typeof ref !== "string" ||
    ref.length === 0 ||
    typeof label !== "string" ||
    label.length > MAX_LABEL_LENGTH ||
    typeof mediaType !== "string" ||
    !isAccess(access) ||
    !isResourceKind(kind) ||
    typeof watch !== "boolean"
  ) {
    throw new OqtoAppError("invalid", "Granted resource is invalid");
  }
  return { role, ref: ref as OqtoFileRef, label, mediaType, access, kind, watch };
}

export function parseGrantedOperation(value: unknown): OqtoGrantedOperation {
  if (!isRecord(value)) throw new OqtoAppError("invalid", "Granted operation must be an object");
  const { id, summary } = value;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
    throw new OqtoAppError("invalid", "Granted operation requires an id");
  }
  if (summary !== undefined && (typeof summary !== "string" || summary.length > MAX_SUMMARY_LENGTH)) {
    throw new OqtoAppError("invalid", "Granted operation summary is invalid");
  }
  return summary === undefined ? { id } : { id, summary };
}

export function parsePresentation(value: unknown): OqtoPresentationContext {
  if (!isRecord(value)) throw new OqtoAppError("invalid", "Presentation context must be an object");
  const { surface, width, height, sizeClass, density, safeArea, reducedMotion } = value;
  if (
    typeof surface !== "string" ||
    !SURFACES.has(surface) ||
    !isDimension(width) ||
    !isDimension(height) ||
    typeof sizeClass !== "string" ||
    !SIZE_CLASSES.has(sizeClass) ||
    typeof density !== "string" ||
    !DENSITIES.has(density) ||
    typeof reducedMotion !== "boolean"
  ) {
    throw new OqtoAppError("invalid", "Presentation context is invalid");
  }
  return {
    surface: surface as OqtoPresentationContext["surface"],
    width,
    height,
    sizeClass: sizeClass as OqtoPresentationContext["sizeClass"],
    density: density as OqtoPresentationContext["density"],
    safeArea: parseInsets(safeArea),
    reducedMotion,
  };
}

function parseInsets(value: unknown): OqtoPresentationContext["safeArea"] {
  if (value === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (!isRecord(value)) throw new OqtoAppError("invalid", "Safe area must be an object");
  const { top, right, bottom, left } = value;
  if (!isDimension(top) || !isDimension(right) || !isDimension(bottom) || !isDimension(left)) {
    throw new OqtoAppError("invalid", "Safe area insets must be finite non-negative numbers");
  }
  return { top, right, bottom, left };
}

function isDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCapability(value: unknown): value is OqtoCapability {
  return typeof value === "string" && CAPABILITIES.has(value as OqtoCapability);
}

function isAccess(value: unknown): value is OqtoResourceAccess {
  return value === "read" || value === "readwrite";
}

function isResourceKind(value: unknown): value is OqtoResourceKind {
  return value === "document" || value === "collection";
}

export function isRequestMessage(value: unknown): value is RequestMessage {
  return (
    isRecord(value) &&
    isProtocolVersion(value.protocol) &&
    value.kind === "request" &&
    Number.isSafeInteger(value.id) &&
    typeof value.method === "string" &&
    value.method.length <= MAX_ID_LENGTH &&
    "params" in value
  );
}

export function isResultMessage(value: unknown): value is ResultMessage {
  return (
    isRecord(value) &&
    isProtocolVersion(value.protocol) &&
    value.kind === "result" &&
    Number.isSafeInteger(value.id) &&
    typeof value.ok === "boolean"
  );
}

export function isEventMessage(value: unknown): value is EventMessage {
  return (
    isRecord(value) &&
    isProtocolVersion(value.protocol) &&
    value.kind === "event" &&
    typeof value.subscriptionId === "string" &&
    value.subscriptionId.length <= MAX_ID_LENGTH &&
    "value" in value
  );
}

export function isCloseMessage(value: unknown): value is CloseMessage {
  return (
    isRecord(value) &&
    isProtocolVersion(value.protocol) &&
    value.kind === "close" &&
    (value.reason === "app" || value.reason === "host" || value.reason === "transport")
  );
}

export function isSuspendMessage(value: unknown): value is SuspendMessage {
  return (
    isRecord(value) &&
    isProtocolVersion(value.protocol) &&
    value.kind === SUSPEND_KIND &&
    typeof value.reason === "string" &&
    SUSPENSION_REASONS.has(value.reason as OqtoSuspensionReason) &&
    (value.message === undefined ||
      (typeof value.message === "string" && value.message.length <= MAX_MESSAGE_LENGTH))
  );
}

export function parseSuspension(value: SuspendMessage): OqtoSuspension {
  return value.message === undefined
    ? { reason: value.reason }
    : { reason: value.reason, message: value.message };
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
