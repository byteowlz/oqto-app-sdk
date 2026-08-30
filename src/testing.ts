import { OqtoAppError } from "./errors.js";
import {
  createOqtoFileRef,
  createOqtoFileVersion,
  serveOqtoAppPort,
  type OqtoHostAdapter,
  type OqtoHostBridge,
} from "./host.js";
import { isJsonValue } from "./internal/json.js";
import { parseHostContext } from "./internal/protocol.js";
import { connectOqtoAppPort } from "./internal/rpc-client.js";
import {
  OQTO_APP_PROTOCOL,
  type JsonValue,
  type OqtoCapability,
  type OqtoFileChange,
  type OqtoFileContents,
  type OqtoFileDescriptor,
  type OqtoFileRef,
  type OqtoFileStat,
  type OqtoFileVersion,
  type OqtoFileWriteResult,
  type OqtoHost,
  type OqtoHostContext,
  type OqtoNotification,
  type OqtoResourceAccess,
  type OqtoThemeSnapshot,
} from "./types.js";

export interface TestFileSeed {
  readonly id: string;
  readonly label?: string;
  readonly mediaType?: string;
  readonly access?: OqtoResourceAccess;
  readonly bytes: Uint8Array | string;
}

export interface CreateTestHostOptions {
  readonly files?: readonly TestFileSeed[];
  readonly boundFileId?: string;
  readonly capabilities?: readonly OqtoCapability[];
  readonly theme?: OqtoThemeSnapshot;
  readonly instanceId?: string;
}

export interface OqtoTestHost {
  readonly adapter: OqtoHostAdapter;
  readonly notifications: readonly OqtoNotification[];
  connect(): OqtoHost;
  ref(fileId: string): OqtoFileRef;
  externalWrite(fileId: string, bytes: Uint8Array | string): OqtoFileVersion;
  contentsOf(fileId: string): Uint8Array;
  versionOf(fileId: string): OqtoFileVersion;
  flushFileChanges(): void;
  setTheme(theme: OqtoThemeSnapshot): void;
  close(): void;
}

interface MemoryFile {
  readonly id: string;
  readonly ref: OqtoFileRef;
  readonly label: string;
  readonly mediaType: string;
  readonly access: OqtoResourceAccess;
  bytes: Uint8Array;
  revision: number;
}

/**
 * Deterministic in-memory host. `connect()` always exercises the real
 * MessageChannel bridge, so tests catch structured-clone and protocol drift.
 */
export function createTestHost(options: CreateTestHostOptions = {}): OqtoTestHost {
  const files = new Map<string, MemoryFile>();
  const refs = new Map<OqtoFileRef, MemoryFile>();
  for (const seed of options.files ?? []) {
    if (files.has(seed.id)) throw new OqtoAppError("invalid", `Duplicate test file id: ${seed.id}`);
    const file: MemoryFile = {
      id: seed.id,
      ref: makeRef(seed.id),
      label: seed.label ?? seed.id,
      mediaType: seed.mediaType ?? "application/octet-stream",
      access: seed.access ?? "readwrite",
      bytes: toBytes(seed.bytes),
      revision: 1,
    };
    files.set(seed.id, file);
    refs.set(file.ref, file);
  }

  const capabilities = options.capabilities ?? (["files", "kv", "theme", "notifications"] as const);
  const boundFile =
    options.boundFileId === undefined ? undefined : requireFileById(files, options.boundFileId);
  const context: OqtoHostContext = {
    protocol: OQTO_APP_PROTOCOL,
    instanceId: options.instanceId ?? "test-instance",
    installationId: "test-installation",
    definitionId: "test-definition",
    capabilities,
    ...(boundFile === undefined
      ? {}
      : {
          bound: {
            ref: boundFile.ref,
            label: boundFile.label,
            mediaType: boundFile.mediaType,
            access: boundFile.access,
            role: "document" as const,
          },
        }),
  };

  const fileWatchers = new Map<OqtoFileRef, Set<(change: OqtoFileChange) => void>>();
  const pendingChanges = new Map<OqtoFileRef, OqtoFileChange>();
  const kv = new Map<string, JsonValue>();
  let theme = options.theme ?? { colorScheme: "dark" as const, tokens: {} };
  const themeWatchers = new Set<(value: OqtoThemeSnapshot) => void>();
  const notifications: OqtoNotification[] = [];
  const bridges = new Set<OqtoHostBridge>();

  const filesCapability = {
    async pick(
      input: { readonly accept?: readonly string[]; readonly multiple?: boolean } = {},
    ): Promise<readonly OqtoFileDescriptor[]> {
      const candidates = Array.from(files.values()).filter((file) => matchesAccept(file, input.accept));
      const picked = input.multiple ? candidates : candidates.slice(0, 1);
      return picked.map(descriptor);
    },
    async read(ref: OqtoFileRef): Promise<OqtoFileContents> {
      const file = requireFileByRef(refs, ref);
      return { ...stat(file), bytes: file.bytes.slice() };
    },
    async stat(ref: OqtoFileRef): Promise<OqtoFileStat> {
      return stat(requireFileByRef(refs, ref));
    },
    async write(
      ref: OqtoFileRef,
      bytes: Uint8Array,
      writeOptions: { readonly expectedVersion: OqtoFileVersion },
    ): Promise<OqtoFileWriteResult> {
      const file = requireFileByRef(refs, ref);
      if (file.access !== "readwrite") throw new OqtoAppError("denied", "File is read-only");
      const currentVersion = version(file);
      if (writeOptions.expectedVersion !== currentVersion) {
        return { ok: false, reason: "conflict", currentVersion };
      }
      replace(file, bytes);
      queueChange(file);
      return { ok: true, stat: stat(file) };
    },
    async watch(ref: OqtoFileRef, listener: (change: OqtoFileChange) => void): Promise<() => void> {
      requireFileByRef(refs, ref);
      const listeners = fileWatchers.get(ref) ?? new Set();
      listeners.add(listener);
      fileWatchers.set(ref, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) fileWatchers.delete(ref);
      };
    },
  };

  const adapter: OqtoHostAdapter = {
    context,
    ...(capabilities.includes("files") ? { files: filesCapability } : {}),
    ...(capabilities.includes("kv")
      ? {
          kv: {
            async get(key: string): Promise<JsonValue | undefined> {
              return cloneJson(kv.get(key));
            },
            async set(key: string, value: JsonValue): Promise<void> {
              if (!isJsonValue(value))
                throw new OqtoAppError("invalid", "KV accepts finite JSON values only");
              kv.set(key, cloneJson(value));
            },
            async delete(key: string): Promise<void> {
              kv.delete(key);
            },
          },
        }
      : {}),
    ...(capabilities.includes("theme")
      ? {
          theme: {
            async get(): Promise<OqtoThemeSnapshot> {
              return cloneTheme(theme);
            },
            async watch(listener: (value: OqtoThemeSnapshot) => void): Promise<() => void> {
              themeWatchers.add(listener);
              return () => themeWatchers.delete(listener);
            },
          },
        }
      : {}),
    ...(capabilities.includes("notifications")
      ? {
          notifications: {
            async notify(notification: OqtoNotification): Promise<void> {
              notifications.push(structuredClone(notification));
            },
          },
        }
      : {}),
  };

  const queueChange = (file: MemoryFile) => {
    pendingChanges.set(file.ref, { ref: file.ref, version: version(file) });
  };

  return {
    adapter,
    notifications,
    connect(): OqtoHost {
      const channel = new MessageChannel();
      const bridge = serveOqtoAppPort(adapter, channel.port1);
      bridges.add(bridge);
      void bridge.closed.then(() => bridges.delete(bridge));
      return connectOqtoAppPort(parseHostContext(structuredClone(context)), channel.port2);
    },
    ref(fileId: string): OqtoFileRef {
      return requireFileById(files, fileId).ref;
    },
    externalWrite(fileId: string, bytes: Uint8Array | string): OqtoFileVersion {
      const file = requireFileById(files, fileId);
      replace(file, toBytes(bytes));
      queueChange(file);
      return version(file);
    },
    contentsOf(fileId: string): Uint8Array {
      return requireFileById(files, fileId).bytes.slice();
    },
    versionOf(fileId: string): OqtoFileVersion {
      return version(requireFileById(files, fileId));
    },
    flushFileChanges(): void {
      const changes = Array.from(pendingChanges.values());
      pendingChanges.clear();
      for (const change of changes) {
        for (const listener of Array.from(fileWatchers.get(change.ref) ?? [])) listener(change);
      }
    },
    setTheme(value: OqtoThemeSnapshot): void {
      theme = cloneTheme(value);
      for (const listener of Array.from(themeWatchers)) listener(cloneTheme(theme));
    },
    close(): void {
      for (const bridge of Array.from(bridges)) bridge.close();
      bridges.clear();
    },
  };
}

function descriptor(file: MemoryFile): OqtoFileDescriptor {
  return { ref: file.ref, label: file.label, mediaType: file.mediaType, access: file.access };
}

function stat(file: MemoryFile): OqtoFileStat {
  return { ...descriptor(file), version: version(file), size: file.bytes.byteLength };
}

function version(file: MemoryFile): OqtoFileVersion {
  return createOqtoFileVersion(`test-v${file.revision}`);
}

function replace(file: MemoryFile, bytes: Uint8Array): void {
  file.bytes = bytes.slice();
  file.revision += 1;
}

function makeRef(id: string): OqtoFileRef {
  return createOqtoFileRef(`oqto-test:${encodeURIComponent(id)}`);
}

function requireFileById(files: ReadonlyMap<string, MemoryFile>, id: string): MemoryFile {
  const file = files.get(id);
  if (!file) throw new OqtoAppError("gone", `Unknown test file: ${id}`);
  return file;
}

function requireFileByRef(files: ReadonlyMap<OqtoFileRef, MemoryFile>, ref: OqtoFileRef): MemoryFile {
  const file = files.get(ref);
  if (!file) throw new OqtoAppError("gone", "File ref is unavailable in this binding");
  return file;
}

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
}

function matchesAccept(file: MemoryFile, accept: readonly string[] | undefined): boolean {
  if (!accept || accept.length === 0) return true;
  return accept.some((pattern) => {
    if (pattern.endsWith("/*")) return file.mediaType.startsWith(pattern.slice(0, -1));
    if (pattern.startsWith(".")) return file.label.toLowerCase().endsWith(pattern.toLowerCase());
    return file.mediaType === pattern;
  });
}

function cloneJson<T extends JsonValue | undefined>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T);
}

function cloneTheme(value: OqtoThemeSnapshot): OqtoThemeSnapshot {
  return { colorScheme: value.colorScheme, tokens: { ...value.tokens } };
}
