import { OqtoAppError } from "./errors.js";
import { isJsonValue } from "./internal/json.js";
import {
  CONNECT_KIND,
  isCloseMessage,
  isReadyMessage,
  isRecord,
  isProtocolVersion,
  isRequestMessage,
  negotiateProtocol,
  readSupportedVersions,
  serializeError,
  SUSPEND_KIND,
  supportsV1,
  supportsV2,
  type ConnectMessage,
  type EventMessage,
  type ResultMessage,
  type SuspendMessage,
} from "./internal/protocol.js";
import {
  OQTO_APP_PROTOCOL_VERSIONS,
  type OqtoAgentContextCapability,
  type OqtoCapability,
  type OqtoFileRef,
  type OqtoFilesCapability,
  type OqtoFileVersion,
  type OqtoHostContext,
  type OqtoKvCapability,
  type OqtoNotificationsCapability,
  type OqtoOperationsCapability,
  type OqtoPresentationCapability,
  type OqtoProtocolVersion,
  type OqtoSuspension,
  type OqtoThemeCapability,
  type OqtoUnsubscribe,
} from "./types.js";

interface PendingSubscription {
  readonly token: symbol;
}
interface ActiveSubscription extends PendingSubscription {
  readonly unsubscribe: OqtoUnsubscribe;
}
type SubscriptionState = PendingSubscription | ActiveSubscription;

interface ResolvedBridgeLimits {
  readonly maxConcurrentRequests: number;
  readonly maxFileWriteBytes: number;
  readonly maxKvBytes: number;
  readonly maxSubscriptions: number;
}

/** Host-side implementation. Every call is additionally checked against context grants. */
export interface OqtoHostAdapter {
  readonly context: OqtoHostContext;
  readonly files?: OqtoFilesCapability;
  readonly kv?: OqtoKvCapability;
  readonly theme?: OqtoThemeCapability;
  readonly notifications?: OqtoNotificationsCapability;
  readonly operations?: OqtoOperationsCapability;
  readonly presentation?: OqtoPresentationCapability;
  readonly agent_context?: OqtoAgentContextCapability;
}

export interface OqtoHostBridge {
  readonly closed: Promise<"app" | "host" | "transport">;
  /** Version negotiated for this bridge. */
  readonly protocol: OqtoProtocolVersion;
  /**
   * Withdraw authority immediately.
   *
   * The App's pending and future calls fail without reaching this adapter, so a
   * revoked grant cannot be exercised by an in-flight request.
   */
  suspend(suspension: OqtoSuspension): void;
  close(): void;
}

export interface OqtoHostBridgeLimits {
  readonly maxConcurrentRequests?: number;
  readonly maxFileWriteBytes?: number;
  readonly maxKvBytes?: number;
  readonly maxSubscriptions?: number;
}

export interface AttachOqtoAppFrameOptions extends OqtoHostBridgeLimits {
  readonly frameWindow: WindowProxy;
  readonly appOrigin: string;
  readonly adapter: OqtoHostAdapter;
  readonly handshakeTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Parent event target; defaults to the current window. Useful for host tests. */
  readonly parentWindow?: Window;
  /**
   * Versions this host accepts, newest first. Defaults to everything the SDK
   * speaks; narrow it to hold a deployment on an older contract.
   */
  readonly supportedVersions?: readonly OqtoProtocolVersion[];
}

/** Create a validated opaque ref in a host adapter without exposing its representation to apps. */
export function createOqtoFileRef(value: string): OqtoFileRef {
  if (value.length === 0 || value.length > 4096) {
    throw new OqtoAppError("invalid", "File ref must contain 1–4096 characters");
  }
  return value as OqtoFileRef;
}

/** Create a validated opaque version token in a host adapter. */
export function createOqtoFileVersion(value: string): OqtoFileVersion {
  if (value.length === 0 || value.length > 1024) {
    throw new OqtoAppError("invalid", "File version must contain 1–1024 characters");
  }
  return value as OqtoFileVersion;
}

/**
 * Wait for one readiness announcement from an exact app frame, then transfer a
 * private MessagePort. Call after creating the iframe; there is no load race.
 */
export async function attachOqtoAppFrame(options: AttachOqtoAppFrameOptions): Promise<OqtoHostBridge> {
  const parentWindow = options.parentWindow ?? window;
  const appOrigin = parseExactOrigin(options.appOrigin);
  validateAdapter(options.adapter);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentWindow.removeEventListener("message", onMessage);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () =>
      finish(() => reject(new OqtoAppError("cancelled", "App frame attachment cancelled")));
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== options.frameWindow || event.origin !== appOrigin || !isReadyMessage(event.data)) {
        return;
      }
      // An App that offers nothing is read as v0-only, so bundles built against
      // the first SDK release keep working unchanged.
      const offered = readSupportedVersions(event.data);
      const protocol = negotiateProtocol(offered, resolveHostVersions(options.supportedVersions));
      if (protocol === undefined) {
        finish(() =>
          reject(
            new OqtoAppError("unsupported", "App and host share no Oqto App protocol version", {
              details: { offered: offered.join(",") },
            }),
          ),
        );
        return;
      }
      const context: OqtoHostContext = { ...options.adapter.context, protocol };
      const channel = new MessageChannel();
      const bridge = serveOqtoAppPort({ ...options.adapter, context }, channel.port1, options);
      const connect: ConnectMessage = {
        protocol,
        kind: CONNECT_KIND,
        nonce: event.data.nonce,
        context,
      };
      try {
        options.frameWindow.postMessage(connect, appOrigin, [channel.port2]);
      } catch (error) {
        channel.port2.close();
        bridge.close();
        finish(() =>
          reject(
            new OqtoAppError("disconnected", "Could not transfer the App bridge port", { cause: error }),
          ),
        );
        return;
      }
      finish(() => resolve(bridge));
    };
    const timer = setTimeout(
      () => finish(() => reject(new OqtoAppError("timeout", "Timed out waiting for the app frame"))),
      options.handshakeTimeoutMs ?? 10_000,
    );

    if (options.signal?.aborted) onAbort();
    else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
      parentWindow.addEventListener("message", onMessage);
    }
  });
}

/** Serve a validated adapter over an already-private MessagePort. */
export function serveOqtoAppPort(
  adapter: OqtoHostAdapter,
  port: MessagePort,
  limits: OqtoHostBridgeLimits = {},
): OqtoHostBridge {
  validateAdapter(adapter);
  const protocol = adapter.context.protocol;
  const subscriptions = new Map<string, SubscriptionState>();
  /** Live operation invocations, so the App can cancel one by its own id. */
  const invocations = new Map<string, AbortController>();
  const resolvedLimits = resolveLimits(limits);
  let activeRequests = 0;
  let didClose = false;
  let suspension: OqtoSuspension | undefined;
  let resolveClosed: ((reason: "app" | "host" | "transport") => void) | undefined;
  const closed = new Promise<"app" | "host" | "transport">((resolve) => {
    resolveClosed = resolve;
  });

  const releaseSubscriptions = () => {
    for (const subscription of subscriptions.values()) {
      if ("unsubscribe" in subscription) subscription.unsubscribe();
    }
    subscriptions.clear();
    for (const controller of invocations.values()) controller.abort();
    invocations.clear();
  };

  const closeAs = (reason: "app" | "host" | "transport", notify: boolean) => {
    if (didClose) return;
    didClose = true;
    if (notify) port.postMessage({ protocol, kind: "close", reason });
    releaseSubscriptions();
    port.close();
    resolveClosed?.(reason);
  };

  /**
   * Stop honouring this mount's authority now. Live subscriptions are released
   * immediately so a revoked grant stops producing data even before the App
   * acknowledges the message.
   */
  const suspendAs = (next: OqtoSuspension) => {
    if (didClose || suspension !== undefined) return;
    suspension = next;
    releaseSubscriptions();
    const message: SuspendMessage = {
      protocol,
      kind: SUSPEND_KIND,
      reason: next.reason,
      ...(next.message === undefined ? {} : { message: next.message }),
    };
    try {
      port.postMessage(message);
    } catch {
      closeAs("transport", false);
    }
  };

  const sendResult = (result: ResultMessage) => {
    if (!didClose) port.postMessage(result);
  };

  port.onmessageerror = () => closeAs("transport", false);
  port.onmessage = (event: MessageEvent<unknown>) => {
    const request = event.data;
    if (isCloseMessage(request)) {
      closeAs("app", false);
      return;
    }
    if (!isRequestMessage(request) || request.protocol !== protocol || didClose) return;
    if (suspension !== undefined) {
      sendResult({
        protocol,
        kind: "result",
        id: request.id,
        ok: false,
        error: serializeError(
          new OqtoAppError("suspended", "This App's access was withdrawn", {
            details: { reason: suspension.reason },
          }),
        ),
      });
      return;
    }
    if (activeRequests >= resolvedLimits.maxConcurrentRequests) {
      sendResult({
        protocol,
        kind: "result",
        id: request.id,
        ok: false,
        error: serializeError(new OqtoAppError("quota_exceeded", "Too many concurrent App requests")),
      });
      return;
    }
    activeRequests += 1;
    void dispatch(
      adapter,
      subscriptions,
      invocations,
      port,
      () => didClose || suspension !== undefined,
      () => closeAs("transport", false),
      resolvedLimits,
      protocol,
      request.method,
      request.params,
    )
      .then((value) => {
        sendResult({ protocol, kind: "result", id: request.id, ok: true, value });
      })
      .catch((error: unknown) => {
        sendResult({
          protocol,
          kind: "result",
          id: request.id,
          ok: false,
          error: serializeError(error),
        });
      })
      .finally(() => {
        activeRequests -= 1;
      });
  };
  port.start();

  return {
    closed,
    protocol,
    suspend: (next: OqtoSuspension) => suspendAs(next),
    close: () => closeAs("host", true),
  };
}

async function dispatch(
  adapter: OqtoHostAdapter,
  subscriptions: Map<string, SubscriptionState>,
  invocations: Map<string, AbortController>,
  port: MessagePort,
  isClosed: () => boolean,
  onTransportError: () => void,
  limits: ResolvedBridgeLimits,
  protocol: OqtoProtocolVersion,
  method: string,
  params: unknown,
): Promise<unknown> {
  const input = requireRecord(params);
  const requireV1 = () => {
    if (!supportsV1(protocol)) {
      throw new OqtoAppError("unsupported", `${method} requires a newer Oqto App protocol`);
    }
  };
  const requireV2 = () => {
    if (!supportsV2(protocol)) {
      throw new OqtoAppError("unsupported", `${method} requires Oqto App protocol v2`);
    }
  };
  switch (method) {
    case "files.pick":
      return requireFiles(adapter).pick(parsePickOptions(input));
    case "files.read":
      return requireFiles(adapter).read(createOqtoFileRef(requireString(input, "ref")));
    case "files.stat":
      return requireFiles(adapter).stat(createOqtoFileRef(requireString(input, "ref")));
    case "files.write": {
      const bytes = input.bytes;
      if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) {
        throw new OqtoAppError("invalid", "files.write requires ArrayBuffer-backed Uint8Array bytes");
      }
      if (bytes.byteLength > limits.maxFileWriteBytes) {
        throw new OqtoAppError("too_large", "File write exceeds the host payload limit");
      }
      return requireFiles(adapter).write(createOqtoFileRef(requireString(input, "ref")), bytes.slice(), {
        expectedVersion: createOqtoFileVersion(requireString(input, "expectedVersion")),
      });
    }
    case "files.watch.start": {
      const files = requireFiles(adapter);
      const ref = createOqtoFileRef(requireString(input, "ref"));
      return startSubscription(
        subscriptions,
        requireBoundedString(input, "subscriptionId", 256),
        limits.maxSubscriptions,
        isClosed,
        onTransportError,
        port,
        protocol,
        (emit) => files.watch(ref, emit),
      );
    }
    case "files.resources": {
      requireV1();
      return requireFiles(adapter).resources();
    }
    case "files.list": {
      requireV1();
      const files = requireFiles(adapter);
      const ref = createOqtoFileRef(requireString(input, "ref"));
      return files.list(ref, parseListOptions(input));
    }
    case "files.watchResources.start": {
      requireV1();
      const files = requireFiles(adapter);
      const refs = parseRefs(input);
      return startSubscription(
        subscriptions,
        requireBoundedString(input, "subscriptionId", 256),
        limits.maxSubscriptions,
        isClosed,
        onTransportError,
        port,
        protocol,
        (emit) => files.watchResources(refs, emit),
      );
    }
    case "files.watch.stop":
    case "files.watchResources.stop":
    case "presentation.watch.stop":
    case "theme.watch.stop":
      stopSubscription(subscriptions, requireBoundedString(input, "subscriptionId", 256));
      return undefined;
    case "operations.list": {
      requireV1();
      return requireOperations(adapter).list();
    }
    case "operations.invoke": {
      requireV1();
      const operations = requireOperations(adapter);
      const id = requireBoundedString(input, "id", 256);
      const invocationId = requireBoundedString(input, "invocationId", 256);
      const rawInput = input.input;
      if (rawInput !== undefined && !isJsonValue(rawInput)) {
        throw new OqtoAppError("invalid", "Operation input must be bounded finite JSON");
      }
      const controller = new AbortController();
      invocations.set(invocationId, controller);
      try {
        return await operations.invoke(id, rawInput as never, { signal: controller.signal });
      } finally {
        invocations.delete(invocationId);
      }
    }
    case "operations.cancel": {
      requireV1();
      invocations.get(requireBoundedString(input, "invocationId", 256))?.abort();
      return undefined;
    }
    case "presentation.get": {
      requireV1();
      return requirePresentation(adapter).get();
    }
    case "presentation.watch.start": {
      requireV1();
      const presentation = requirePresentation(adapter);
      return startSubscription(
        subscriptions,
        requireBoundedString(input, "subscriptionId", 256),
        limits.maxSubscriptions,
        isClosed,
        onTransportError,
        port,
        protocol,
        (emit) => presentation.watch(emit),
      );
    }
    case "agentContext.catalog": {
      requireV2();
      return requireAgentContext(adapter).catalog();
    }
    case "agentContext.get": {
      requireV2();
      return requireAgentContext(adapter).get(requireBoundedString(input, "topic", 256));
    }
    case "agentContext.publish": {
      requireV2();
      const value = input.value;
      if (!isJsonValue(value)) throw new OqtoAppError("invalid", "Context accepts bounded finite JSON only");
      return requireAgentContext(adapter).publish(requireBoundedString(input, "topic", 256), value);
    }
    case "agentContext.clear": {
      requireV2();
      await requireAgentContext(adapter).clear(requireBoundedString(input, "topic", 256));
      return undefined;
    }
    case "agentContext.watch.start": {
      requireV2();
      const context = requireAgentContext(adapter);
      const topics = parseTopics(input);
      const fromRevision = parseOptionalRevision(input, "fromRevision");
      return startSubscription(
        subscriptions,
        requireBoundedString(input, "subscriptionId", 256),
        limits.maxSubscriptions,
        isClosed,
        onTransportError,
        port,
        protocol,
        (emit) => context.watch(topics, emit, fromRevision === undefined ? {} : { fromRevision }),
      );
    }
    case "agentContext.watch.stop":
      requireV2();
      stopSubscription(subscriptions, requireBoundedString(input, "subscriptionId", 256));
      return undefined;
    case "agentContext.action.invoke": {
      requireV2();
      const value = input.input;
      if (value !== undefined && !isJsonValue(value)) {
        throw new OqtoAppError("invalid", "Context action input accepts bounded finite JSON only");
      }
      return requireAgentContext(adapter).invokeAction(
        requireBoundedString(input, "id", 256),
        parseRevision(input, "expectedContextRevision"),
        value,
      );
    }
    case "kv.get":
      return requireKv(adapter).get(requireKey(input));
    case "kv.set": {
      const value = input.value;
      if (!isJsonValue(value))
        throw new OqtoAppError("invalid", "KV accepts bounded finite JSON values only");
      const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (bytes > limits.maxKvBytes) {
        throw new OqtoAppError("too_large", "KV value exceeds the host payload limit");
      }
      await requireKv(adapter).set(requireKey(input), value);
      return undefined;
    }
    case "kv.delete":
      await requireKv(adapter).delete(requireKey(input));
      return undefined;
    case "theme.get":
      return requireTheme(adapter).get();
    case "theme.watch.start": {
      const theme = requireTheme(adapter);
      return startSubscription(
        subscriptions,
        requireBoundedString(input, "subscriptionId", 256),
        limits.maxSubscriptions,
        isClosed,
        onTransportError,
        port,
        protocol,
        (emit) => theme.watch(emit),
      );
    }
    case "notifications.notify": {
      const level = requireString(input, "level");
      const message = requireString(input, "message");
      if (message.length > 4096) throw new OqtoAppError("too_large", "Notification message is too long");
      if (level !== "info" && level !== "success" && level !== "warning" && level !== "error") {
        throw new OqtoAppError("invalid", "Unknown notification level");
      }
      await requireNotifications(adapter).notify({ level, message });
      return undefined;
    }
    default:
      throw new OqtoAppError("unsupported", `Unsupported host operation: ${method}`);
  }
}

async function startSubscription(
  subscriptions: Map<string, SubscriptionState>,
  subscriptionId: string,
  maxSubscriptions: number,
  isClosed: () => boolean,
  onTransportError: () => void,
  port: MessagePort,
  protocol: OqtoProtocolVersion,
  subscribe: (emit: (value: unknown) => void) => Promise<OqtoUnsubscribe>,
): Promise<void> {
  if (subscriptions.has(subscriptionId)) throw new OqtoAppError("invalid", "Subscription already exists");
  if (subscriptions.size >= maxSubscriptions) {
    throw new OqtoAppError("quota_exceeded", "App subscription limit reached");
  }
  const pending: PendingSubscription = { token: Symbol(subscriptionId) };
  subscriptions.set(subscriptionId, pending);
  let unsubscribe: OqtoUnsubscribe;
  try {
    unsubscribe = await subscribe((value) => {
      if (isClosed() || subscriptions.get(subscriptionId)?.token !== pending.token) return;
      const event: EventMessage = {
        protocol,
        kind: "event",
        subscriptionId,
        value,
      };
      try {
        port.postMessage(event);
      } catch {
        onTransportError();
      }
    });
  } catch (error) {
    if (subscriptions.get(subscriptionId) === pending) subscriptions.delete(subscriptionId);
    throw error;
  }
  if (isClosed() || subscriptions.get(subscriptionId) !== pending) {
    unsubscribe();
    if (isClosed()) throw new OqtoAppError("disconnected", "App bridge closed while subscribing");
    return;
  }
  subscriptions.set(subscriptionId, { token: pending.token, unsubscribe });
}

function stopSubscription(subscriptions: Map<string, SubscriptionState>, subscriptionId: string): void {
  const subscription = subscriptions.get(subscriptionId);
  if (subscription === undefined) throw new OqtoAppError("gone", "Subscription does not exist");
  subscriptions.delete(subscriptionId);
  if ("unsubscribe" in subscription) subscription.unsubscribe();
}

function validateAdapter(adapter: OqtoHostAdapter): void {
  if (!isProtocolVersion(adapter.context.protocol)) {
    throw new OqtoAppError("unsupported", `Unsupported protocol: ${adapter.context.protocol}`);
  }
  for (const capability of adapter.context.capabilities) {
    if (adapter[capability] === undefined) {
      throw new OqtoAppError("invalid", `Granted capability has no adapter: ${capability}`);
    }
  }
}

function requireCapability(adapter: OqtoHostAdapter, capability: OqtoCapability): void {
  if (!adapter.context.capabilities.includes(capability)) {
    throw new OqtoAppError("denied", `${capability} capability is not granted`);
  }
}

function requireFiles(adapter: OqtoHostAdapter): OqtoFilesCapability {
  requireCapability(adapter, "files");
  if (!adapter.files) throw new OqtoAppError("denied", "Files capability is not granted");
  return adapter.files;
}

function requireKv(adapter: OqtoHostAdapter): OqtoKvCapability {
  requireCapability(adapter, "kv");
  if (!adapter.kv) throw new OqtoAppError("denied", "KV capability is not granted");
  return adapter.kv;
}

function requireTheme(adapter: OqtoHostAdapter): OqtoThemeCapability {
  requireCapability(adapter, "theme");
  if (!adapter.theme) throw new OqtoAppError("denied", "Theme capability is not granted");
  return adapter.theme;
}

function requireNotifications(adapter: OqtoHostAdapter): OqtoNotificationsCapability {
  requireCapability(adapter, "notifications");
  if (!adapter.notifications) throw new OqtoAppError("denied", "Notifications capability is not granted");
  return adapter.notifications;
}

function requireOperations(adapter: OqtoHostAdapter): OqtoOperationsCapability {
  requireCapability(adapter, "operations");
  if (!adapter.operations) throw new OqtoAppError("denied", "Operations capability is not granted");
  return adapter.operations;
}

function requirePresentation(adapter: OqtoHostAdapter): OqtoPresentationCapability {
  requireCapability(adapter, "presentation");
  if (!adapter.presentation) throw new OqtoAppError("denied", "Presentation capability is not granted");
  return adapter.presentation;
}

function requireAgentContext(adapter: OqtoHostAdapter): OqtoAgentContextCapability {
  requireCapability(adapter, "agent_context");
  if (!adapter.agent_context) throw new OqtoAppError("denied", "Agent Context capability is not granted");
  return adapter.agent_context;
}

function resolveHostVersions(
  explicit: readonly OqtoProtocolVersion[] | undefined,
): readonly OqtoProtocolVersion[] {
  if (explicit === undefined) return OQTO_APP_PROTOCOL_VERSIONS;
  const supported = OQTO_APP_PROTOCOL_VERSIONS.filter((version) => explicit.includes(version));
  if (supported.length === 0) {
    throw new OqtoAppError("invalid", "supportedVersions must include a protocol this SDK speaks");
  }
  return supported;
}

function parseRefs(input: Record<string, unknown>): readonly OqtoFileRef[] {
  const refs = input.refs;
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > 64) {
    throw new OqtoAppError("invalid", "refs must be a bounded non-empty array");
  }
  return refs.map((ref) => {
    if (typeof ref !== "string") throw new OqtoAppError("invalid", "refs must contain strings");
    return createOqtoFileRef(ref);
  });
}

function parseListOptions(input: Record<string, unknown>): {
  cursor?: string;
  limit?: number;
} {
  const result: { cursor?: string; limit?: number } = {};
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || input.cursor.length === 0 || input.cursor.length > 4096) {
      throw new OqtoAppError("invalid", "list.cursor must be a bounded non-empty string");
    }
    result.cursor = input.cursor;
  }
  if (input.limit !== undefined) {
    if (!Number.isSafeInteger(input.limit) || (input.limit as number) <= 0) {
      throw new OqtoAppError("invalid", "list.limit must be a positive safe integer");
    }
    result.limit = input.limit as number;
  }
  return result;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new OqtoAppError("invalid", "Operation parameters must be an object");
  return value;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new OqtoAppError("invalid", `${key} must be a non-empty string`);
  }
  return value;
}

function requireBoundedString(input: Record<string, unknown>, key: string, maxLength: number): string {
  const value = requireString(input, key);
  if (value.length > maxLength) {
    throw new OqtoAppError("invalid", `${key} exceeds ${maxLength} characters`);
  }
  return value;
}

function requireKey(input: Record<string, unknown>): string {
  return requireBoundedString(input, "key", 256);
}

function parseTopics(input: Record<string, unknown>): readonly string[] {
  const topics = input.topics;
  if (!Array.isArray(topics) || topics.length === 0 || topics.length > 64) {
    throw new OqtoAppError("invalid", "topics must be a bounded non-empty array");
  }
  const values = topics.map((topic) => {
    if (typeof topic !== "string" || topic.length === 0 || topic.length > 256) {
      throw new OqtoAppError("invalid", "topics must contain bounded non-empty strings");
    }
    return topic;
  });
  if (new Set(values).size !== values.length) throw new OqtoAppError("invalid", "topics must be unique");
  return values;
}

function parseRevision(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OqtoAppError("invalid", `${key} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseOptionalRevision(input: Record<string, unknown>, key: string): number | undefined {
  return input[key] === undefined ? undefined : parseRevision(input, key);
}

function parsePickOptions(input: Record<string, unknown>): {
  accept?: readonly string[];
  multiple?: boolean;
} {
  const result: { accept?: readonly string[]; multiple?: boolean } = {};
  if (input.accept !== undefined) {
    if (
      !Array.isArray(input.accept) ||
      input.accept.length > 32 ||
      !input.accept.every((item) => typeof item === "string" && item.length <= 256)
    ) {
      throw new OqtoAppError("invalid", "pick.accept must be a bounded array of strings");
    }
    result.accept = input.accept;
  }
  if (input.multiple !== undefined) {
    if (typeof input.multiple !== "boolean") {
      throw new OqtoAppError("invalid", "pick.multiple must be boolean");
    }
    result.multiple = input.multiple;
  }
  return result;
}

function parseExactOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OqtoAppError("invalid", "appOrigin must be an absolute URL origin", { cause: error });
  }
  if (
    url.origin === "null" ||
    url.origin.includes("*") ||
    (url.href !== url.origin && url.href !== `${url.origin}/`)
  ) {
    throw new OqtoAppError("invalid", "appOrigin must be an exact non-opaque origin");
  }
  return url.origin;
}

function resolveLimits(limits: OqtoHostBridgeLimits): ResolvedBridgeLimits {
  return {
    maxConcurrentRequests: validateLimit("maxConcurrentRequests", limits.maxConcurrentRequests, 32),
    maxFileWriteBytes: validateLimit("maxFileWriteBytes", limits.maxFileWriteBytes, 64 * 1024 * 1024),
    maxKvBytes: validateLimit("maxKvBytes", limits.maxKvBytes, 256 * 1024),
    maxSubscriptions: validateLimit("maxSubscriptions", limits.maxSubscriptions, 128),
  };
}

function validateLimit(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OqtoAppError("invalid", `${name} must be a positive safe integer`);
  }
  return value;
}
