/** Handshake protocol tag. Also the negotiated version for v0 hosts. */
export const OQTO_APP_PROTOCOL = "oqto-app/v0" as const;

/** Negotiated protocol adding operations, multi-resource files, and presentation. */
export const OQTO_APP_PROTOCOL_V1 = "oqto-app/v1" as const;

/** Negotiated protocol adding App-defined Agent Context and contextual actions. */
export const OQTO_APP_PROTOCOL_V2 = "oqto-app/v2" as const;

/**
 * Versions this SDK can speak, newest first. The host picks one; an older host
 * that ignores the offer keeps the v0 behaviour it already implements.
 */
export const OQTO_APP_PROTOCOL_VERSIONS = [
  OQTO_APP_PROTOCOL_V2,
  OQTO_APP_PROTOCOL_V1,
  OQTO_APP_PROTOCOL,
] as const;

export type OqtoProtocolVersion = (typeof OQTO_APP_PROTOCOL_VERSIONS)[number];

/** A JSON value accepted by transport-neutral capabilities such as KV. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

declare const fileRefBrand: unique symbol;
declare const fileVersionBrand: unique symbol;

/**
 * Opaque identity for a resource inside the current binding scope.
 *
 * Refs are serializable and may be stored by the same App Instance, but they
 * must never be parsed, constructed, or treated as paths. The host validates
 * the binding and grant on every use.
 */
export type OqtoFileRef = string & { readonly [fileRefBrand]: true };

/** Opaque freshness token. Compare only for equality; never parse or order it. */
export type OqtoFileVersion = string & { readonly [fileVersionBrand]: true };

export type OqtoCapability =
  | "files"
  | "kv"
  | "theme"
  | "notifications"
  | "operations"
  | "presentation"
  | "agent_context";

export type OqtoResourceAccess = "read" | "readwrite";

export interface OqtoFileDescriptor {
  readonly ref: OqtoFileRef;
  /** Display-only label, never a path. */
  readonly label: string;
  readonly mediaType: string;
  readonly access: OqtoResourceAccess;
}

export interface OqtoBoundResource extends OqtoFileDescriptor {
  readonly role: "document";
}

/** Whether a granted resource holds bytes or contains other resources. */
export type OqtoResourceKind = "document" | "collection";

/**
 * One resource the host actually granted, named by the App's own role.
 *
 * The role is the semantic name from the manifest request (`outputs`, `jobs`);
 * the ref is opaque identity. Neither is a host path.
 */
export interface OqtoGrantedResource extends OqtoFileDescriptor {
  readonly role: string;
  readonly kind: OqtoResourceKind;
  /** True when the host will deliver change events for this resource. */
  readonly watch: boolean;
}

/** One pinned operation the host granted, with the author's own description. */
export interface OqtoGrantedOperation {
  readonly id: string;
  readonly summary?: string;
}

/**
 * Exactly what this mount may do.
 *
 * A manifest request is not a grant: this snapshot reflects the live decision,
 * so an App should drive its interface from here rather than from what it asked
 * for. The host re-checks every call regardless.
 */
export interface OqtoGrantSnapshot {
  readonly capabilities: readonly OqtoCapability[];
  readonly resources: readonly OqtoGrantedResource[];
  readonly operations: readonly OqtoGrantedOperation[];
}

export type OqtoPresentationSurface = "inline" | "container" | "fullscreen" | "window";

/** Coarse width band. Apps should branch on this, never on a raw pixel guess. */
export type OqtoSizeClass = "compact" | "regular" | "expanded";

export type OqtoDensity = "comfortable" | "compact";

export interface OqtoEdgeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * The container an App is rendered into, which is not the browser viewport.
 *
 * An App may be mounted in a narrow split pane, a phone-sized sheet, or a
 * fullscreen surface. Sizing against `window.innerWidth` is wrong; size against
 * this instead.
 */
export interface OqtoPresentationContext {
  readonly surface: OqtoPresentationSurface;
  /** Container width in CSS pixels. */
  readonly width: number;
  /** Container height in CSS pixels. */
  readonly height: number;
  readonly sizeClass: OqtoSizeClass;
  readonly density: OqtoDensity;
  readonly safeArea: OqtoEdgeInsets;
  readonly reducedMotion: boolean;
}

export interface OqtoHostContext {
  readonly protocol: OqtoProtocolVersion;
  readonly instanceId: string;
  readonly installationId: string;
  readonly definitionId: string;
  /** Capabilities granted for this mount, not merely requested by its manifest. */
  readonly capabilities: readonly OqtoCapability[];
  /**
   * Full grant detail. On a v0 host this is synthesized from `capabilities`
   * with empty resource and operation lists.
   */
  readonly grants: OqtoGrantSnapshot;
  /** Immutable for the lifetime of a mount. Rebinding creates a new mount. */
  readonly bound?: OqtoBoundResource;
  /** Mount-time container snapshot. Absent on v0 hosts. */
  readonly presentation?: OqtoPresentationContext;
}

export interface OqtoFilePickOptions {
  readonly accept?: readonly string[];
  readonly multiple?: boolean;
}

export interface OqtoFileStat {
  readonly ref: OqtoFileRef;
  readonly version: OqtoFileVersion;
  readonly label: string;
  readonly mediaType: string;
  readonly size: number;
  readonly access: OqtoResourceAccess;
  /** Advisory host timestamp; version is authoritative for concurrency. */
  readonly modifiedAt?: string;
}

export interface OqtoFileContents extends OqtoFileStat {
  readonly bytes: Uint8Array;
}

export interface OqtoFileChange {
  readonly ref: OqtoFileRef;
  readonly version: OqtoFileVersion;
  /**
   * Monotonic per-subscription sequence number. Absent on v0 hosts.
   *
   * A jump larger than one means the host coalesced events; `gap` states that
   * explicitly so an App can re-read instead of assuming it observed every
   * intermediate version.
   */
  readonly generation?: number;
  /** True when events were coalesced or dropped before this one. */
  readonly gap?: boolean;
}

/** One entry inside a granted collection resource. */
export interface OqtoFileEntry extends OqtoFileDescriptor {
  readonly version: OqtoFileVersion;
  readonly size: number;
  readonly modifiedAt?: string;
}

export interface OqtoFileListOptions {
  /** Opaque continuation token from a previous page. Never parse it. */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface OqtoFileListPage {
  readonly entries: readonly OqtoFileEntry[];
  /** Present when more entries remain. */
  readonly cursor?: string;
}

export type OqtoFileWriteResult =
  | {
      readonly ok: true;
      readonly stat: OqtoFileStat;
    }
  | {
      readonly ok: false;
      readonly reason: "conflict";
      readonly currentVersion: OqtoFileVersion;
    };

export type OqtoUnsubscribe = () => void;

export interface OqtoFilesCapability {
  /** Host-owned picker. Returned refs remain constrained to the binding scope. */
  pick(options?: OqtoFilePickOptions): Promise<readonly OqtoFileDescriptor[]>;
  read(ref: OqtoFileRef): Promise<OqtoFileContents>;
  stat(ref: OqtoFileRef): Promise<OqtoFileStat>;
  /**
   * Atomically replace a resource only when its current version matches.
   * There is deliberately no unconditional document write in v0.
   */
  write(
    ref: OqtoFileRef,
    bytes: Uint8Array,
    options: { readonly expectedVersion: OqtoFileVersion },
  ): Promise<OqtoFileWriteResult>;
  /** Events may coalesce to the newest version. They never contain file bytes. */
  watch(ref: OqtoFileRef, listener: (change: OqtoFileChange) => void): Promise<OqtoUnsubscribe>;
  /**
   * Granted resources by role. Requires a v1 host; a v0 host rejects with
   * `unsupported`.
   */
  resources(): Promise<readonly OqtoGrantedResource[]>;
  /** Enumerate a granted collection resource. Requires a v1 host. */
  list(ref: OqtoFileRef, options?: OqtoFileListOptions): Promise<OqtoFileListPage>;
  /**
   * Observe several resources through one subscription. Requires a v1 host.
   *
   * Changes carry `generation` and `gap` so a listener can tell a coalesced
   * stream from a complete one.
   */
  watchResources(
    refs: readonly OqtoFileRef[],
    listener: (change: OqtoFileChange) => void,
  ): Promise<OqtoUnsubscribe>;
}

export interface OqtoOperationInvokeOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * An operation that ran and reported failure. This is an outcome, not a
 * transport or authorization error, so it is returned rather than thrown.
 */
export interface OqtoOperationFailure {
  readonly ok: false;
  readonly reason: "failed";
  /** Stable host- or App-defined failure code, never a raw exit status string. */
  readonly code: string;
  readonly message: string;
}

export interface OqtoOperationSuccess {
  readonly ok: true;
  readonly output: JsonValue;
}

export type OqtoOperationResult = OqtoOperationSuccess | OqtoOperationFailure;

/**
 * Typed client for pinned semantic operations.
 *
 * The App names an operation id and passes JSON. It never sees an executable,
 * argument vector, environment, or endpoint; the runner resolves those from the
 * immutable Definition under the bound Principal.
 */
export interface OqtoOperationsCapability {
  list(): Promise<readonly OqtoGrantedOperation[]>;
  invoke(id: string, input?: JsonValue, options?: OqtoOperationInvokeOptions): Promise<OqtoOperationResult>;
}

export interface OqtoPresentationCapability {
  get(): Promise<OqtoPresentationContext>;
  watch(listener: (context: OqtoPresentationContext) => void): Promise<OqtoUnsubscribe>;
}

export type OqtoContextLifetime = "ephemeral" | "session_local" | "durable_reference";
export type OqtoContextDisclosure = "ambient" | "explicit_intent" | "sensitive" | "high_volume";

/** Immutable topic declaration shipped by the pinned App Definition. */
export interface OqtoContextTopic {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly schemaVersion: string;
  readonly lifetime: OqtoContextLifetime;
  readonly disclosure: OqtoContextDisclosure;
}

/** Immutable contextual action declaration shipped by the pinned Definition. */
export interface OqtoContextAction {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly requiredTopics: readonly string[];
  readonly requiresUserActivation: boolean;
}

export interface OqtoAgentContextCatalog {
  readonly providerId: string;
  readonly topics: readonly OqtoContextTopic[];
  readonly actions: readonly OqtoContextAction[];
}

/** Current host-revisioned value of one declared topic. */
export interface OqtoContextSnapshot {
  readonly providerId: string;
  readonly topic: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly value: JsonValue;
}

export interface OqtoContextChange {
  readonly snapshot: OqtoContextSnapshot;
  /** Monotonic sequence within this subscription. */
  readonly generation: number;
  /** True when the subscriber must refresh rather than assume continuity. */
  readonly gap: boolean;
}

export type OqtoContextActionResult =
  | { readonly ok: true; readonly output: JsonValue }
  | { readonly ok: false; readonly reason: "stale_context"; readonly currentRevision: number }
  | { readonly ok: false; readonly reason: "failed"; readonly code: string; readonly message: string };

/**
 * App side of ADR-0044. Publishing only updates typed state; it never wakes an
 * Agent or inserts a Chat message. Mutation uses revision-bound actions.
 */
export interface OqtoAgentContextCapability {
  catalog(): Promise<OqtoAgentContextCatalog>;
  get(topic: string): Promise<OqtoContextSnapshot | undefined>;
  publish(topic: string, value: JsonValue): Promise<OqtoContextSnapshot>;
  clear(topic: string): Promise<void>;
  watch(
    topics: readonly string[],
    listener: (change: OqtoContextChange) => void,
    options?: { readonly fromRevision?: number },
  ): Promise<OqtoUnsubscribe>;
  invokeAction(
    id: string,
    expectedContextRevision: number,
    input?: JsonValue,
  ): Promise<OqtoContextActionResult>;
}

export interface OqtoKvCapability {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
}

export type OqtoColorScheme = "light" | "dark";

export interface OqtoThemeSnapshot {
  readonly colorScheme: OqtoColorScheme;
  /** CSS custom-property names to resolved values, e.g. `--oqto-bg`. */
  readonly tokens: Readonly<Record<string, string>>;
}

export interface OqtoThemeCapability {
  get(): Promise<OqtoThemeSnapshot>;
  watch(listener: (theme: OqtoThemeSnapshot) => void): Promise<OqtoUnsubscribe>;
}

export type OqtoNotificationLevel = "info" | "success" | "warning" | "error";

export interface OqtoNotification {
  readonly level: OqtoNotificationLevel;
  readonly message: string;
}

export interface OqtoNotificationsCapability {
  notify(notification: OqtoNotification): Promise<void>;
}

/** Why a mount lost its authority. */
export type OqtoSuspensionReason = "revoked" | "suspended" | "uninstalled" | "definition_changed";

/**
 * Authority withdrawal announced by the host.
 *
 * Suspension is immediate and terminal for this mount: pending calls reject and
 * later calls reject without reaching the host. Regaining access requires a new
 * decision and a fresh mount.
 */
export interface OqtoSuspension {
  readonly reason: OqtoSuspensionReason;
  readonly message?: string;
}

export type OqtoCloseReason = "app" | "host" | "transport";

/** The complete granted interface presented to an app mount. */
export interface OqtoHost {
  readonly context: OqtoHostContext;
  /** Version actually negotiated with this host. */
  readonly protocol: OqtoProtocolVersion;
  readonly files?: OqtoFilesCapability;
  readonly kv?: OqtoKvCapability;
  readonly theme?: OqtoThemeCapability;
  readonly notifications?: OqtoNotificationsCapability;
  readonly operations?: OqtoOperationsCapability;
  readonly presentation?: OqtoPresentationCapability;
  readonly agentContext?: OqtoAgentContextCapability;
  readonly closed: Promise<OqtoCloseReason>;
  /** Resolves once the host withdraws authority. Never rejects. */
  readonly suspension: Promise<OqtoSuspension>;
  /** Synchronous suspension check for render paths. */
  isSuspended(): OqtoSuspension | undefined;
  onSuspended(listener: (suspension: OqtoSuspension) => void): OqtoUnsubscribe;
  close(): void;
}
