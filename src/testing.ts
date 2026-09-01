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
  OQTO_APP_PROTOCOL_V1,
  type JsonValue,
  type OqtoCapability,
  type OqtoFileChange,
  type OqtoFileContents,
  type OqtoFileDescriptor,
  type OqtoFileEntry,
  type OqtoFileListOptions,
  type OqtoFileListPage,
  type OqtoFileRef,
  type OqtoFileStat,
  type OqtoFileVersion,
  type OqtoFileWriteResult,
  type OqtoGrantedOperation,
  type OqtoGrantedResource,
  type OqtoHost,
  type OqtoHostContext,
  type OqtoNotification,
  type OqtoOperationResult,
  type OqtoPresentationContext,
  type OqtoProtocolVersion,
  type OqtoResourceAccess,
  type OqtoSuspension,
  type OqtoThemeSnapshot,
} from "./types.js";

export interface TestFileSeed {
  readonly id: string;
  /** Grant role. Defaults to the id. */
  readonly role?: string;
  readonly label?: string;
  readonly mediaType?: string;
  readonly access?: OqtoResourceAccess;
  /** Whether the grant promises change events. Defaults to true. */
  readonly watch?: boolean;
  readonly bytes: Uint8Array | string;
}

export interface TestCollectionSeed {
  readonly id: string;
  readonly role?: string;
  readonly label?: string;
  readonly access?: OqtoResourceAccess;
  readonly watch?: boolean;
  /** Ids of seeded files that belong to this collection. */
  readonly entries: readonly string[];
}

export interface TestOperationSeed {
  readonly id: string;
  readonly summary?: string;
  /** Defaults to echoing the input. Throw to model a transport-level failure. */
  readonly handler?: (
    input: JsonValue | undefined,
    signal: AbortSignal,
  ) => Promise<OqtoOperationResult> | OqtoOperationResult;
}

export interface RecordedInvocation {
  readonly id: string;
  readonly input: JsonValue | undefined;
}

export interface CreateTestHostOptions {
  readonly files?: readonly TestFileSeed[];
  readonly collections?: readonly TestCollectionSeed[];
  readonly boundFileId?: string;
  readonly capabilities?: readonly OqtoCapability[];
  readonly theme?: OqtoThemeSnapshot;
  readonly presentation?: OqtoPresentationContext;
  readonly operations?: readonly TestOperationSeed[];
  readonly instanceId?: string;
  /** Version the simulated host negotiates. Defaults to the newest. */
  readonly protocol?: OqtoProtocolVersion;
}

export interface ConnectTestHostOptions {
  /** Override the negotiated version to exercise compatibility paths. */
  readonly protocol?: OqtoProtocolVersion;
}

export interface OqtoTestHost {
  readonly adapter: OqtoHostAdapter;
  readonly notifications: readonly OqtoNotification[];
  readonly invocations: readonly RecordedInvocation[];
  connect(options?: ConnectTestHostOptions): OqtoHost;
  ref(fileId: string): OqtoFileRef;
  externalWrite(fileId: string, bytes: Uint8Array | string): OqtoFileVersion;
  contentsOf(fileId: string): Uint8Array;
  versionOf(fileId: string): OqtoFileVersion;
  flushFileChanges(): void;
  setTheme(theme: OqtoThemeSnapshot): void;
  setPresentation(presentation: OqtoPresentationContext): void;
  /** Withdraw authority on every live bridge, as a revocation would. */
  suspend(suspension: OqtoSuspension): void;
  close(): void;
}

interface MemoryFile {
  readonly id: string;
  readonly ref: OqtoFileRef;
  readonly role: string;
  readonly label: string;
  readonly mediaType: string;
  readonly access: OqtoResourceAccess;
  readonly watch: boolean;
  bytes: Uint8Array;
  revision: number;
}

interface MemoryCollection {
  readonly id: string;
  readonly ref: OqtoFileRef;
  readonly role: string;
  readonly label: string;
  readonly access: OqtoResourceAccess;
  readonly watch: boolean;
  readonly entries: readonly string[];
}

interface FileWatcher {
  readonly refs: ReadonlySet<OqtoFileRef>;
  readonly listener: (change: OqtoFileChange) => void;
  generation: number;
}

const DEFAULT_PRESENTATION: OqtoPresentationContext = {
  surface: "container",
  width: 960,
  height: 720,
  sizeClass: "regular",
  density: "comfortable",
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  reducedMotion: false,
};

/**
 * Deterministic in-memory host. `connect()` always exercises the real
 * MessageChannel bridge, so tests catch structured-clone and protocol drift.
 */
export function createTestHost(options: CreateTestHostOptions = {}): OqtoTestHost {
  const files = new Map<string, MemoryFile>();
  const collections = new Map<string, MemoryCollection>();
  const refs = new Map<OqtoFileRef, MemoryFile>();
  const collectionRefs = new Map<OqtoFileRef, MemoryCollection>();

  for (const seed of options.files ?? []) {
    if (files.has(seed.id)) throw new OqtoAppError("invalid", `Duplicate test file id: ${seed.id}`);
    const file: MemoryFile = {
      id: seed.id,
      ref: makeRef(seed.id),
      role: seed.role ?? seed.id,
      label: seed.label ?? seed.id,
      mediaType: seed.mediaType ?? "application/octet-stream",
      access: seed.access ?? "readwrite",
      watch: seed.watch ?? true,
      bytes: toBytes(seed.bytes),
      revision: 1,
    };
    files.set(seed.id, file);
    refs.set(file.ref, file);
  }
  for (const seed of options.collections ?? []) {
    if (files.has(seed.id) || collections.has(seed.id)) {
      throw new OqtoAppError("invalid", `Duplicate test resource id: ${seed.id}`);
    }
    for (const entry of seed.entries) requireFileById(files, entry);
    const collection: MemoryCollection = {
      id: seed.id,
      ref: makeRef(seed.id),
      role: seed.role ?? seed.id,
      label: seed.label ?? seed.id,
      access: seed.access ?? "read",
      watch: seed.watch ?? true,
      entries: [...seed.entries],
    };
    collections.set(seed.id, collection);
    collectionRefs.set(collection.ref, collection);
  }

  const capabilities =
    options.capabilities ??
    (["files", "kv", "theme", "notifications", "operations", "presentation"] as const);
  const boundFile =
    options.boundFileId === undefined ? undefined : requireFileById(files, options.boundFileId);
  const operationSeeds = new Map<string, TestOperationSeed>();
  for (const seed of options.operations ?? []) operationSeeds.set(seed.id, seed);

  const grantedResources: readonly OqtoGrantedResource[] = [
    ...Array.from(files.values()).map(
      (file): OqtoGrantedResource => ({
        role: file.role,
        ref: file.ref,
        label: file.label,
        mediaType: file.mediaType,
        access: file.access,
        kind: "document",
        watch: file.watch,
      }),
    ),
    ...Array.from(collections.values()).map(
      (collection): OqtoGrantedResource => ({
        role: collection.role,
        ref: collection.ref,
        label: collection.label,
        mediaType: "inode/directory",
        access: collection.access,
        kind: "collection",
        watch: collection.watch,
      }),
    ),
  ];
  const grantedOperations: readonly OqtoGrantedOperation[] = Array.from(operationSeeds.values()).map(
    (seed) => (seed.summary === undefined ? { id: seed.id } : { id: seed.id, summary: seed.summary }),
  );

  const buildContext = (protocol: OqtoProtocolVersion): OqtoHostContext => ({
    protocol,
    instanceId: options.instanceId ?? "test-instance",
    installationId: "test-installation",
    definitionId: "test-definition",
    capabilities,
    // v0 has no way to convey resource or operation detail, so a v0 mount sees
    // the capability list only — the same degradation a real v0 host produces.
    grants:
      protocol === OQTO_APP_PROTOCOL_V1
        ? { capabilities, resources: grantedResources, operations: grantedOperations }
        : { capabilities, resources: [], operations: [] },
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
    ...(protocol === OQTO_APP_PROTOCOL_V1 ? { presentation } : {}),
  });

  const fileWatchers = new Set<FileWatcher>();
  /** Coalesced change counts per ref, so a flush can report a real gap. */
  const pendingChanges = new Map<OqtoFileRef, { version: OqtoFileVersion; coalesced: number }>();
  const kv = new Map<string, JsonValue>();
  let theme = options.theme ?? { colorScheme: "dark" as const, tokens: {} };
  let presentation = options.presentation ?? DEFAULT_PRESENTATION;
  const themeWatchers = new Set<(value: OqtoThemeSnapshot) => void>();
  const presentationWatchers = new Set<(value: OqtoPresentationContext) => void>();
  const notifications: OqtoNotification[] = [];
  const invocations: RecordedInvocation[] = [];
  const bridges = new Set<OqtoHostBridge>();

  const queueChange = (file: MemoryFile) => {
    const existing = pendingChanges.get(file.ref);
    pendingChanges.set(file.ref, {
      version: version(file),
      coalesced: (existing?.coalesced ?? 0) + 1,
    });
  };

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
      requireWatchable(refs, collectionRefs, ref);
      const watcher: FileWatcher = { refs: new Set([ref]), listener, generation: 0 };
      fileWatchers.add(watcher);
      return () => fileWatchers.delete(watcher);
    },
    async resources(): Promise<readonly OqtoGrantedResource[]> {
      return grantedResources.map((resource) => ({ ...resource }));
    },
    async list(ref: OqtoFileRef, listOptions?: OqtoFileListOptions): Promise<OqtoFileListPage> {
      const collection = collectionRefs.get(ref);
      if (!collection) throw new OqtoAppError("gone", "Ref is not a granted collection");
      const members = collection.entries.map((id) => requireFileById(files, id));
      const start = listOptions?.cursor === undefined ? 0 : decodeCursor(listOptions.cursor);
      const limit = listOptions?.limit ?? members.length;
      const slice = members.slice(start, start + limit);
      const next = start + slice.length;
      const entries: readonly OqtoFileEntry[] = slice.map(stat);
      return next < members.length ? { entries, cursor: encodeCursor(next) } : { entries };
    },
    async watchResources(
      watched: readonly OqtoFileRef[],
      listener: (change: OqtoFileChange) => void,
    ): Promise<() => void> {
      for (const ref of watched) requireWatchable(refs, collectionRefs, ref);
      const expanded = new Set<OqtoFileRef>();
      for (const ref of watched) {
        const collection = collectionRefs.get(ref);
        if (collection) {
          for (const id of collection.entries) expanded.add(requireFileById(files, id).ref);
          continue;
        }
        expanded.add(ref);
      }
      const watcher: FileWatcher = { refs: expanded, listener, generation: 0 };
      fileWatchers.add(watcher);
      return () => fileWatchers.delete(watcher);
    },
  };

  const adapter: OqtoHostAdapter = {
    context: buildContext(options.protocol ?? OQTO_APP_PROTOCOL_V1),
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
    ...(capabilities.includes("operations")
      ? {
          operations: {
            async list(): Promise<readonly OqtoGrantedOperation[]> {
              return grantedOperations.map((operation) => ({ ...operation }));
            },
            async invoke(
              id: string,
              input?: JsonValue,
              invokeOptions?: { readonly signal?: AbortSignal },
            ): Promise<OqtoOperationResult> {
              const seed = operationSeeds.get(id);
              if (!seed) throw new OqtoAppError("denied", `Operation is not granted: ${id}`);
              invocations.push({ id, input: cloneJson(input) });
              const signal = invokeOptions?.signal ?? new AbortController().signal;
              if (seed.handler === undefined) {
                return { ok: true, output: input === undefined ? null : cloneJson(input) };
              }
              return seed.handler(input, signal);
            },
          },
        }
      : {}),
    ...(capabilities.includes("presentation")
      ? {
          presentation: {
            async get(): Promise<OqtoPresentationContext> {
              return clonePresentation(presentation);
            },
            async watch(listener: (value: OqtoPresentationContext) => void): Promise<() => void> {
              presentationWatchers.add(listener);
              return () => presentationWatchers.delete(listener);
            },
          },
        }
      : {}),
  };

  return {
    adapter,
    notifications,
    invocations,
    connect(connectOptions: ConnectTestHostOptions = {}): OqtoHost {
      const protocol = connectOptions.protocol ?? adapter.context.protocol;
      const context = buildContext(protocol);
      const channel = new MessageChannel();
      const bridge = serveOqtoAppPort({ ...adapter, context }, channel.port1);
      bridges.add(bridge);
      void bridge.closed.then(() => bridges.delete(bridge));
      return connectOqtoAppPort(parseHostContext(structuredClone(context)), channel.port2);
    },
    ref(fileId: string): OqtoFileRef {
      const file = files.get(fileId);
      if (file) return file.ref;
      const collection = collections.get(fileId);
      if (collection) return collection.ref;
      throw new OqtoAppError("gone", `Unknown test resource: ${fileId}`);
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
      const changes = Array.from(pendingChanges.entries());
      pendingChanges.clear();
      for (const [ref, pending] of changes) {
        for (const watcher of Array.from(fileWatchers)) {
          if (!watcher.refs.has(ref)) continue;
          watcher.generation += 1;
          const change: OqtoFileChange = {
            ref,
            version: pending.version,
            generation: watcher.generation,
            ...(pending.coalesced > 1 ? { gap: true } : {}),
          };
          watcher.listener(change);
        }
      }
    },
    setTheme(value: OqtoThemeSnapshot): void {
      theme = cloneTheme(value);
      for (const listener of Array.from(themeWatchers)) listener(cloneTheme(theme));
    },
    setPresentation(value: OqtoPresentationContext): void {
      presentation = clonePresentation(value);
      for (const listener of Array.from(presentationWatchers)) listener(clonePresentation(presentation));
    },
    suspend(suspension: OqtoSuspension): void {
      for (const bridge of Array.from(bridges)) bridge.suspend(suspension);
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

function encodeCursor(index: number): string {
  return `cursor:${index}`;
}

function decodeCursor(cursor: string): number {
  const index = Number.parseInt(cursor.replace("cursor:", ""), 10);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new OqtoAppError("invalid", "Unknown list cursor");
  }
  return index;
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

function requireWatchable(
  files: ReadonlyMap<OqtoFileRef, MemoryFile>,
  collections: ReadonlyMap<OqtoFileRef, MemoryCollection>,
  ref: OqtoFileRef,
): void {
  if (!files.has(ref) && !collections.has(ref)) {
    throw new OqtoAppError("gone", "Ref is unavailable in this binding");
  }
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

function clonePresentation(value: OqtoPresentationContext): OqtoPresentationContext {
  return { ...value, safeArea: { ...value.safeArea } };
}
