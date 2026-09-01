import { OqtoAppError } from "../errors.js";
import {
  OQTO_APP_PROTOCOL,
  type JsonValue,
  type OqtoFileChange,
  type OqtoFileContents,
  type OqtoFileDescriptor,
  type OqtoFileEntry,
  type OqtoFileListOptions,
  type OqtoFileListPage,
  type OqtoFilePickOptions,
  type OqtoFileRef,
  type OqtoFileStat,
  type OqtoFileVersion,
  type OqtoFileWriteResult,
  type OqtoGrantedOperation,
  type OqtoGrantedResource,
  type OqtoHost,
  type OqtoHostContext,
  type OqtoNotification,
  type OqtoOperationInvokeOptions,
  type OqtoOperationResult,
  type OqtoPresentationContext,
  type OqtoProtocolVersion,
  type OqtoSuspension,
  type OqtoThemeSnapshot,
  type OqtoUnsubscribe,
} from "../types.js";
import { deferred } from "./deferred.js";
import { isJsonValue } from "./json.js";
import {
  deserializeError,
  isCloseMessage,
  isEventMessage,
  isRecord,
  isResultMessage,
  isSuspendMessage,
  parseGrantedOperation,
  parseGrantedResource,
  parsePresentation,
  parseSuspension,
  supportsV1,
  type RequestMessage,
} from "./protocol.js";

interface PendingRequest {
  readonly reject: (error: unknown) => void;
  readonly settle: (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RpcClientOptions {
  readonly requestTimeoutMs?: number;
}

class RpcClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly subscriptions = new Map<string, (value: unknown) => void>();
  private readonly closedState = deferred<"app" | "host" | "transport">();
  private readonly suspensionState = deferred<OqtoSuspension>();
  private readonly suspensionListeners = new Set<(suspension: OqtoSuspension) => void>();
  private nextId = 1;
  private didClose = false;
  private suspension: OqtoSuspension | undefined;

  readonly closed = this.closedState.promise;
  readonly suspended = this.suspensionState.promise;

  constructor(
    readonly protocol: OqtoProtocolVersion,
    private readonly port: MessagePort,
    private readonly requestTimeoutMs: number,
  ) {
    port.onmessage = (event) => this.receive(event.data);
    port.onmessageerror = () => this.closeAs("transport");
    port.start();
  }

  suspensionOf(): OqtoSuspension | undefined {
    return this.suspension;
  }

  onSuspended(listener: (suspension: OqtoSuspension) => void): OqtoUnsubscribe {
    if (this.suspension !== undefined) {
      const current = this.suspension;
      queueMicrotask(() => listener(current));
      return () => undefined;
    }
    this.suspensionListeners.add(listener);
    return () => {
      this.suspensionListeners.delete(listener);
    };
  }

  request(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    if (this.suspension !== undefined) return Promise.reject(suspendedError(this.suspension));
    if (this.didClose) return Promise.reject(new OqtoAppError("disconnected", "Oqto host is disconnected"));
    const id = this.nextId;
    this.nextId += 1;
    const message: RequestMessage = {
      protocol: this.protocol,
      kind: "request",
      id,
      method,
      params,
    };
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(id);
        if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
      };
      const timer = setTimeout(
        () =>
          settle({ ok: false, error: new OqtoAppError("timeout", `Host operation timed out: ${method}`) }),
        options.timeoutMs ?? this.requestTimeoutMs,
      );
      this.pending.set(id, {
        reject: (error) => settle({ ok: false, error }),
        settle,
        timer,
      });
      try {
        this.port.postMessage(message);
      } catch (error) {
        settle({
          ok: false,
          error: new OqtoAppError("disconnected", "Could not reach the Oqto host", { cause: error }),
        });
      }
    });
  }

  /** Fire-and-forget notification that must not fail an App code path. */
  post(method: string, params: unknown): void {
    if (this.didClose || this.suspension !== undefined) return;
    const message: RequestMessage = {
      protocol: this.protocol,
      kind: "request",
      id: this.nextId,
      method,
      params,
    };
    this.nextId += 1;
    try {
      this.port.postMessage(message);
    } catch {
      // A dead port is already reported through `closed`.
    }
  }

  addSubscription(id: string, listener: (value: unknown) => void): void {
    this.subscriptions.set(id, listener);
  }

  removeSubscription(id: string): void {
    this.subscriptions.delete(id);
  }

  requireLive(): void {
    if (this.suspension !== undefined) throw suspendedError(this.suspension);
    if (this.didClose) throw new OqtoAppError("disconnected", "Oqto host is disconnected");
  }

  close(): void {
    if (this.didClose) return;
    try {
      this.port.postMessage({ protocol: this.protocol, kind: "close", reason: "app" });
    } finally {
      this.closeAs("app");
    }
  }

  private receive(value: unknown): void {
    if (!isRecord(value) || value.protocol !== this.protocol) return;
    if (isResultMessage(value)) {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      if (value.ok) pending.settle({ ok: true, value: value.value });
      else pending.settle({ ok: false, error: deserializeError(value.error) });
      return;
    }
    if (isEventMessage(value)) {
      this.subscriptions.get(value.subscriptionId)?.(value.value);
      return;
    }
    if (isSuspendMessage(value)) {
      this.suspendAs(parseSuspension(value));
      return;
    }
    if (isCloseMessage(value)) this.closeAs("host");
  }

  /**
   * Withdraw authority immediately.
   *
   * Pending work rejects and later calls never reach the host, so a revoked
   * grant cannot be exercised by a request that was already in flight.
   */
  private suspendAs(suspension: OqtoSuspension): void {
    if (this.suspension !== undefined) return;
    this.suspension = suspension;
    const error = suspendedError(suspension);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.subscriptions.clear();
    this.suspensionState.resolve(suspension);
    const listeners = Array.from(this.suspensionListeners);
    this.suspensionListeners.clear();
    for (const listener of listeners) listener(suspension);
  }

  private closeAs(reason: "app" | "host" | "transport"): void {
    if (this.didClose) return;
    this.didClose = true;
    this.port.close();
    const error = new OqtoAppError("disconnected", "Oqto host disconnected");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.subscriptions.clear();
    this.closedState.resolve(reason);
  }
}

function suspendedError(suspension: OqtoSuspension): OqtoAppError {
  return new OqtoAppError(
    "suspended",
    suspension.message ?? `Oqto host withdrew this App's access (${suspension.reason})`,
    { details: { reason: suspension.reason } },
  );
}

export function connectOqtoAppPort(
  context: OqtoHostContext,
  port: MessagePort,
  options: RpcClientOptions = {},
): OqtoHost {
  const protocol = context.protocol;
  const client = new RpcClient(protocol, port, options.requestTimeoutMs ?? 30_000);
  const has = (capability: (typeof context.capabilities)[number]) =>
    context.capabilities.includes(capability);
  const v1 = supportsV1(protocol);
  const requireV1 = (feature: string): void => {
    if (!v1) {
      throw new OqtoAppError(
        "unsupported",
        `${feature} requires protocol ${"oqto-app/v1"}; this host negotiated ${protocol}`,
      );
    }
  };

  /**
   * Register a subscription, then roll it back if the host refuses.
   *
   * `stopMethod` stays capability-specific because a v0 host only understands
   * `files.watch.stop` and `theme.watch.stop`.
   */
  const subscribe = async (
    prefix: string,
    stopMethod: string,
    start: (subscriptionId: string) => Promise<unknown>,
    onValue: (value: unknown) => void,
  ): Promise<OqtoUnsubscribe> => {
    const subscriptionId = newOpaqueId(prefix);
    client.addSubscription(subscriptionId, onValue);
    try {
      await start(subscriptionId);
    } catch (error) {
      client.removeSubscription(subscriptionId);
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      client.removeSubscription(subscriptionId);
      void client.request(stopMethod, { subscriptionId }).catch(() => undefined);
    };
  };

  const files = has("files")
    ? {
        async pick(pickOptions?: OqtoFilePickOptions): Promise<readonly OqtoFileDescriptor[]> {
          return parseFileDescriptors(await client.request("files.pick", pickOptions ?? {}));
        },
        async read(ref: OqtoFileRef): Promise<OqtoFileContents> {
          return parseFileContents(await client.request("files.read", { ref }));
        },
        async stat(ref: OqtoFileRef): Promise<OqtoFileStat> {
          return parseFileStat(await client.request("files.stat", { ref }));
        },
        async write(
          ref: OqtoFileRef,
          bytes: Uint8Array,
          writeOptions: { readonly expectedVersion: OqtoFileVersion },
        ): Promise<OqtoFileWriteResult> {
          return parseWriteResult(
            await client.request("files.write", {
              ref,
              bytes: bytes.slice(),
              expectedVersion: writeOptions.expectedVersion,
            }),
          );
        },
        async watch(ref: OqtoFileRef, listener: (change: OqtoFileChange) => void): Promise<OqtoUnsubscribe> {
          const track = trackGenerations();
          return subscribe(
            "file-watch",
            "files.watch.stop",
            (subscriptionId) => client.request("files.watch.start", { ref, subscriptionId }),
            (value) => listener(track(parseFileChange(value))),
          );
        },
        async resources(): Promise<readonly OqtoGrantedResource[]> {
          requireV1("files.resources");
          const value = await client.request("files.resources", {});
          if (!Array.isArray(value)) throw invalidResponse("granted resources");
          return value.map(parseGrantedResource);
        },
        async list(ref: OqtoFileRef, listOptions?: OqtoFileListOptions): Promise<OqtoFileListPage> {
          requireV1("files.list");
          return parseListPage(
            await client.request("files.list", {
              ref,
              ...(listOptions?.cursor === undefined ? {} : { cursor: listOptions.cursor }),
              ...(listOptions?.limit === undefined ? {} : { limit: listOptions.limit }),
            }),
          );
        },
        async watchResources(
          refs: readonly OqtoFileRef[],
          listener: (change: OqtoFileChange) => void,
        ): Promise<OqtoUnsubscribe> {
          requireV1("files.watchResources");
          if (refs.length === 0) {
            throw new OqtoAppError("invalid", "watchResources requires at least one ref");
          }
          const track = trackGenerations();
          return subscribe(
            "files-watch",
            "files.watchResources.stop",
            (subscriptionId) =>
              client.request("files.watchResources.start", { refs: [...refs], subscriptionId }),
            (value) => listener(track(parseFileChange(value))),
          );
        },
      }
    : undefined;

  const operations = has("operations")
    ? {
        async list(): Promise<readonly OqtoGrantedOperation[]> {
          requireV1("operations.list");
          const value = await client.request("operations.list", {});
          if (!Array.isArray(value)) throw invalidResponse("operation list");
          return value.map(parseGrantedOperation);
        },
        async invoke(
          id: string,
          input?: JsonValue,
          invokeOptions?: OqtoOperationInvokeOptions,
        ): Promise<OqtoOperationResult> {
          requireV1("operations.invoke");
          if (typeof id !== "string" || id.length === 0) {
            throw new OqtoAppError("invalid", "Operation id must be a non-empty string");
          }
          if (input !== undefined && !isJsonValue(input)) {
            throw new OqtoAppError("invalid", "Operation input must be bounded finite JSON");
          }
          const signal = invokeOptions?.signal;
          if (signal?.aborted) throw new OqtoAppError("cancelled", "Operation cancelled before dispatch");

          const invocationId = newOpaqueId("op");
          const timeoutMs = invokeOptions?.timeoutMs;
          const pending = client.request(
            "operations.invoke",
            { id, invocationId, ...(input === undefined ? {} : { input }) },
            timeoutMs === undefined ? {} : { timeoutMs },
          );
          if (signal === undefined) return parseOperationResult(await pending);

          const onAbort = () => client.post("operations.cancel", { invocationId });
          signal.addEventListener("abort", onAbort, { once: true });
          try {
            return parseOperationResult(await pending);
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
        },
      }
    : undefined;

  const presentation = has("presentation")
    ? {
        async get(): Promise<OqtoPresentationContext> {
          requireV1("presentation.get");
          return parsePresentation(await client.request("presentation.get", {}));
        },
        async watch(listener: (value: OqtoPresentationContext) => void): Promise<OqtoUnsubscribe> {
          requireV1("presentation.watch");
          return subscribe(
            "presentation-watch",
            "presentation.watch.stop",
            (subscriptionId) => client.request("presentation.watch.start", { subscriptionId }),
            (value) => listener(parsePresentation(value)),
          );
        },
      }
    : undefined;

  const kv = has("kv")
    ? {
        async get(key: string): Promise<JsonValue | undefined> {
          const result = await client.request("kv.get", { key });
          return result === undefined ? undefined : parseJsonValue(result);
        },
        async set(key: string, value: JsonValue): Promise<void> {
          if (!isJsonValue(value)) {
            throw new OqtoAppError("invalid", "KV accepts bounded finite JSON values only");
          }
          await client.request("kv.set", { key, value });
        },
        async delete(key: string): Promise<void> {
          await client.request("kv.delete", { key });
        },
      }
    : undefined;

  const theme = has("theme")
    ? {
        async get(): Promise<OqtoThemeSnapshot> {
          return parseTheme(await client.request("theme.get", {}));
        },
        async watch(listener: (theme: OqtoThemeSnapshot) => void): Promise<OqtoUnsubscribe> {
          return subscribe(
            "theme-watch",
            "theme.watch.stop",
            (subscriptionId) => client.request("theme.watch.start", { subscriptionId }),
            (value) => listener(parseTheme(value)),
          );
        },
      }
    : undefined;

  const notifications = has("notifications")
    ? {
        async notify(notification: OqtoNotification): Promise<void> {
          await client.request("notifications.notify", notification);
        },
      }
    : undefined;

  return {
    context,
    protocol,
    ...(files === undefined ? {} : { files }),
    ...(kv === undefined ? {} : { kv }),
    ...(theme === undefined ? {} : { theme }),
    ...(notifications === undefined ? {} : { notifications }),
    ...(operations === undefined ? {} : { operations }),
    ...(presentation === undefined ? {} : { presentation }),
    closed: client.closed,
    suspension: client.suspended,
    isSuspended: () => client.suspensionOf(),
    onSuspended: (listener) => client.onSuspended(listener),
    close: () => client.close(),
  };
}

/**
 * Mark a change stream with a client-side gap flag.
 *
 * The host owns `generation`; this only decides whether the App observed a
 * contiguous run. A v0 host sends no generation, so nothing is inferred.
 */
function trackGenerations(): (change: OqtoFileChange) => OqtoFileChange {
  let last: number | undefined;
  return (change) => {
    if (change.generation === undefined) return change;
    const previous = last;
    last = change.generation;
    if (change.gap === true) return change;
    if (previous !== undefined && change.generation > previous + 1) return { ...change, gap: true };
    return change;
  };
}

function parseFileDescriptors(value: unknown): readonly OqtoFileDescriptor[] {
  if (!Array.isArray(value)) throw invalidResponse("file picker");
  return value.map(parseFileDescriptor);
}

function parseFileDescriptor(value: unknown): OqtoFileDescriptor {
  if (!isRecord(value)) throw invalidResponse("file descriptor");
  const { ref, label, mediaType, access } = value;
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    typeof label !== "string" ||
    typeof mediaType !== "string" ||
    (access !== "read" && access !== "readwrite")
  ) {
    throw invalidResponse("file descriptor");
  }
  return { ref: ref as OqtoFileRef, label, mediaType, access };
}

function parseFileStat(value: unknown): OqtoFileStat {
  const descriptor = parseFileDescriptor(value);
  if (!isRecord(value)) throw invalidResponse("file stat");
  const size = value.size;
  if (
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    throw invalidResponse("file stat");
  }
  const modifiedAt = value.modifiedAt;
  if (modifiedAt !== undefined && typeof modifiedAt !== "string") throw invalidResponse("file stat");
  return {
    ...descriptor,
    version: value.version as OqtoFileVersion,
    size,
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
  };
}

function parseFileEntry(value: unknown): OqtoFileEntry {
  return parseFileStat(value);
}

function parseListPage(value: unknown): OqtoFileListPage {
  if (!isRecord(value) || !Array.isArray(value.entries)) throw invalidResponse("file list");
  const cursor = value.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0)) {
    throw invalidResponse("file list");
  }
  const entries = value.entries.map(parseFileEntry);
  return cursor === undefined ? { entries } : { entries, cursor };
}

function parseFileContents(value: unknown): OqtoFileContents {
  const stat = parseFileStat(value);
  if (!isRecord(value) || !(value.bytes instanceof Uint8Array)) throw invalidResponse("file contents");
  return { ...stat, bytes: value.bytes };
}

function parseWriteResult(value: unknown): OqtoFileWriteResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") throw invalidResponse("file write");
  if (value.ok) return { ok: true, stat: parseFileStat(value.stat) };
  if (
    value.reason !== "conflict" ||
    typeof value.currentVersion !== "string" ||
    value.currentVersion.length === 0
  )
    throw invalidResponse("file write");
  return { ok: false, reason: "conflict", currentVersion: value.currentVersion as OqtoFileVersion };
}

function parseFileChange(value: unknown): OqtoFileChange {
  if (
    !isRecord(value) ||
    typeof value.ref !== "string" ||
    value.ref.length === 0 ||
    typeof value.version !== "string" ||
    value.version.length === 0
  ) {
    throw invalidResponse("file change");
  }
  const generation = value.generation;
  if (
    generation !== undefined &&
    (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)
  ) {
    throw invalidResponse("file change");
  }
  const gap = value.gap;
  if (gap !== undefined && typeof gap !== "boolean") throw invalidResponse("file change");
  return {
    ref: value.ref as OqtoFileRef,
    version: value.version as OqtoFileVersion,
    ...(generation === undefined ? {} : { generation }),
    ...(gap === undefined ? {} : { gap }),
  };
}

function parseOperationResult(value: unknown): OqtoOperationResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") throw invalidResponse("operation");
  if (value.ok) {
    if (!isJsonValue(value.output)) throw invalidResponse("operation");
    return { ok: true, output: value.output };
  }
  if (
    value.reason !== "failed" ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.message !== "string"
  ) {
    throw invalidResponse("operation");
  }
  return { ok: false, reason: "failed", code: value.code, message: value.message };
}

function parseJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw invalidResponse("KV value");
  return value;
}

function parseTheme(value: unknown): OqtoThemeSnapshot {
  if (
    !isRecord(value) ||
    (value.colorScheme !== "light" && value.colorScheme !== "dark") ||
    !isRecord(value.tokens)
  ) {
    throw invalidResponse("theme");
  }
  const entries = Object.entries(value.tokens);
  if (!entries.every((entry) => entry[0].startsWith("--") && typeof entry[1] === "string")) {
    throw invalidResponse("theme");
  }
  return { colorScheme: value.colorScheme, tokens: Object.fromEntries(entries) as Record<string, string> };
}

function invalidResponse(subject: string): OqtoAppError {
  return new OqtoAppError("internal", `Host returned an invalid ${subject} response`);
}

function newOpaqueId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

/** Re-exported so the v0 tag stays reachable for compatibility checks. */
export const CLIENT_BASELINE_PROTOCOL = OQTO_APP_PROTOCOL;
