export const OQTO_APP_PROTOCOL = "oqto-app/v0" as const;

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

export type OqtoCapability = "files" | "kv" | "theme" | "notifications";
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

export interface OqtoHostContext {
  readonly protocol: typeof OQTO_APP_PROTOCOL;
  readonly instanceId: string;
  readonly installationId: string;
  readonly definitionId: string;
  /** Capabilities granted for this mount, not merely requested by its manifest. */
  readonly capabilities: readonly OqtoCapability[];
  /** Immutable for the lifetime of a mount. Rebinding creates a new mount. */
  readonly bound?: OqtoBoundResource;
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

export type OqtoCloseReason = "app" | "host" | "transport";

/** The complete granted interface presented to an app mount. */
export interface OqtoHost {
  readonly context: OqtoHostContext;
  readonly files?: OqtoFilesCapability;
  readonly kv?: OqtoKvCapability;
  readonly theme?: OqtoThemeCapability;
  readonly notifications?: OqtoNotificationsCapability;
  readonly closed: Promise<OqtoCloseReason>;
  close(): void;
}
