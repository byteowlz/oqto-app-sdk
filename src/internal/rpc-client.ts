import { OqtoAppError } from "../errors.js";
import {
  OQTO_APP_PROTOCOL,
  type JsonValue,
  type OqtoFileChange,
  type OqtoFileContents,
  type OqtoFileDescriptor,
  type OqtoFilePickOptions,
  type OqtoFileRef,
  type OqtoFileStat,
  type OqtoFileVersion,
  type OqtoFileWriteResult,
  type OqtoHost,
  type OqtoHostContext,
  type OqtoNotification,
  type OqtoThemeSnapshot,
} from "../types.js";
import { deferred } from "./deferred.js";
import { isJsonValue } from "./json.js";
import {
  deserializeError,
  isCloseMessage,
  isEventMessage,
  isRecord,
  isResultMessage,
  type RequestMessage,
} from "./protocol.js";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RpcClientOptions {
  readonly requestTimeoutMs?: number;
}

class RpcClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly subscriptions = new Map<string, (value: unknown) => void>();
  private readonly closedState = deferred<"app" | "host" | "transport">();
  private nextId = 1;
  private didClose = false;

  readonly closed = this.closedState.promise;

  constructor(
    private readonly port: MessagePort,
    private readonly requestTimeoutMs: number,
  ) {
    port.onmessage = (event) => this.receive(event.data);
    port.onmessageerror = () => this.closeAs("transport");
    port.start();
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.didClose) return Promise.reject(new OqtoAppError("disconnected", "Oqto host is disconnected"));
    const id = this.nextId;
    this.nextId += 1;
    const message: RequestMessage = { protocol: OQTO_APP_PROTOCOL, kind: "request", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OqtoAppError("timeout", `Host operation timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage(message);
    });
  }

  addSubscription(id: string, listener: (value: unknown) => void): void {
    this.subscriptions.set(id, listener);
  }

  removeSubscription(id: string): void {
    this.subscriptions.delete(id);
  }

  close(): void {
    if (this.didClose) return;
    try {
      this.port.postMessage({ protocol: OQTO_APP_PROTOCOL, kind: "close", reason: "app" });
    } finally {
      this.closeAs("app");
    }
  }

  private receive(value: unknown): void {
    if (isResultMessage(value)) {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if (value.ok) pending.resolve(value.value);
      else pending.reject(deserializeError(value.error));
      return;
    }
    if (isEventMessage(value)) {
      this.subscriptions.get(value.subscriptionId)?.(value.value);
      return;
    }
    if (isCloseMessage(value)) this.closeAs("host");
  }

  private closeAs(reason: "app" | "host" | "transport"): void {
    if (this.didClose) return;
    this.didClose = true;
    this.port.close();
    const error = new OqtoAppError("disconnected", "Oqto host disconnected");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.subscriptions.clear();
    this.closedState.resolve(reason);
  }
}

export function connectOqtoAppPort(
  context: OqtoHostContext,
  port: MessagePort,
  options: RpcClientOptions = {},
): OqtoHost {
  const client = new RpcClient(port, options.requestTimeoutMs ?? 30_000);
  const has = (capability: (typeof context.capabilities)[number]) =>
    context.capabilities.includes(capability);

  const files = has("files")
    ? {
        async pick(options?: OqtoFilePickOptions): Promise<readonly OqtoFileDescriptor[]> {
          return parseFileDescriptors(await client.request("files.pick", options ?? {}));
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
          options: { readonly expectedVersion: OqtoFileVersion },
        ): Promise<OqtoFileWriteResult> {
          return parseWriteResult(
            await client.request("files.write", {
              ref,
              bytes: bytes.slice(),
              expectedVersion: options.expectedVersion,
            }),
          );
        },
        async watch(ref: OqtoFileRef, listener: (change: OqtoFileChange) => void): Promise<() => void> {
          const subscriptionId = newOpaqueId("file-watch");
          client.addSubscription(subscriptionId, (value) => listener(parseFileChange(value)));
          try {
            await client.request("files.watch.start", { ref, subscriptionId });
          } catch (error) {
            client.removeSubscription(subscriptionId);
            throw error;
          }
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            client.removeSubscription(subscriptionId);
            void client.request("files.watch.stop", { subscriptionId }).catch(() => undefined);
          };
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
        async watch(listener: (theme: OqtoThemeSnapshot) => void): Promise<() => void> {
          const subscriptionId = newOpaqueId("theme-watch");
          client.addSubscription(subscriptionId, (value) => listener(parseTheme(value)));
          try {
            await client.request("theme.watch.start", { subscriptionId });
          } catch (error) {
            client.removeSubscription(subscriptionId);
            throw error;
          }
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            client.removeSubscription(subscriptionId);
            void client.request("theme.watch.stop", { subscriptionId }).catch(() => undefined);
          };
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
    ...(files === undefined ? {} : { files }),
    ...(kv === undefined ? {} : { kv }),
    ...(theme === undefined ? {} : { theme }),
    ...(notifications === undefined ? {} : { notifications }),
    closed: client.closed,
    close: () => client.close(),
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
  return { ref: value.ref as OqtoFileRef, version: value.version as OqtoFileVersion };
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
