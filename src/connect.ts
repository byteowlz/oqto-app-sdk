import { OqtoAppError } from "./errors.js";
import { connectOqtoAppPort } from "./internal/rpc-client.js";
import {
  CONNECT_KIND,
  isRecord,
  parseConnectMessage,
  READY_KIND,
  type ReadyMessage,
} from "./internal/protocol.js";
import {
  OQTO_APP_PROTOCOL,
  OQTO_APP_PROTOCOL_VERSIONS,
  type OqtoHost,
  type OqtoProtocolVersion,
} from "./types.js";

export interface ConnectOqtoAppOptions {
  /**
   * Exact Oqto shell origin. Defaults to the origin of `document.referrer`.
   * Wildcards are never accepted.
   */
  readonly hostOrigin?: string;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Protocol versions to offer, newest first. Defaults to everything this SDK
   * speaks. Narrow it only to pin an App to an older contract on purpose.
   */
  readonly supportedVersions?: readonly OqtoProtocolVersion[];
}

/**
 * Connect a sandboxed-web App to its Oqto host.
 *
 * The app announces readiness to its exact parent origin, offering the protocol
 * versions it speaks. The host responds once with a nonce-bound MessagePort and
 * the version it selected; all later traffic uses only that port and version.
 * A host that predates negotiation simply answers `oqto-app/v0`.
 */
export async function connectOqtoApp(options: ConnectOqtoAppOptions = {}): Promise<OqtoHost> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new OqtoAppError("unsupported", "connectOqtoApp requires a browser iframe");
  }
  if (window.parent === window) {
    throw new OqtoAppError("denied", "Oqto Apps must be mounted inside a host frame");
  }

  const hostOrigin = resolveHostOrigin(options.hostOrigin);
  const supportedVersions = resolveSupportedVersions(options.supportedVersions);
  const nonce = newNonce();
  const timeoutMs = options.handshakeTimeoutMs ?? 10_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () =>
      finish(() => reject(new OqtoAppError("cancelled", "Oqto host connection cancelled")));
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== hostOrigin) return;
      // The nonce, not the version, decides whether this reply is ours.
      if (!isRecord(event.data) || event.data.kind !== CONNECT_KIND || event.data.nonce !== nonce) {
        for (const port of event.ports) port.close();
        return;
      }
      const port = event.ports[0];
      if (event.ports.length !== 1 || !port) {
        for (const transferred of event.ports) transferred.close();
        finish(() => reject(new OqtoAppError("invalid", "Host handshake requires one MessagePort")));
        return;
      }
      try {
        const message = parseConnectMessage(event.data, nonce, supportedVersions);
        finish(() =>
          resolve(
            connectOqtoAppPort(
              message.context,
              port,
              options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
            ),
          ),
        );
      } catch (error) {
        port.close();
        finish(() => reject(error));
      }
    };
    const timer = setTimeout(
      () => finish(() => reject(new OqtoAppError("timeout", "Timed out waiting for the Oqto host"))),
      timeoutMs,
    );

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    window.addEventListener("message", onMessage);
    // The envelope keeps the v0 tag so hosts predating negotiation still parse
    // it; `supportedVersions` is the additive offer newer hosts read.
    const ready: ReadyMessage = {
      protocol: OQTO_APP_PROTOCOL,
      kind: READY_KIND,
      nonce,
      supportedVersions,
    };
    try {
      window.parent.postMessage(ready, hostOrigin);
    } catch (error) {
      finish(() =>
        reject(new OqtoAppError("disconnected", "Could not announce App readiness", { cause: error })),
      );
    }
  });
}

function resolveSupportedVersions(
  explicit: readonly OqtoProtocolVersion[] | undefined,
): readonly OqtoProtocolVersion[] {
  if (explicit === undefined) return OQTO_APP_PROTOCOL_VERSIONS;
  const offered = OQTO_APP_PROTOCOL_VERSIONS.filter((version) => explicit.includes(version));
  if (offered.length === 0) {
    throw new OqtoAppError("invalid", "supportedVersions must include a protocol this SDK speaks");
  }
  return offered;
}

function resolveHostOrigin(explicit: string | undefined): string {
  const candidate = explicit ?? document.referrer;
  if (!candidate) {
    throw new OqtoAppError(
      "invalid",
      "Host origin is unavailable; pass hostOrigin or preserve the iframe document referrer",
    );
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch (error) {
    throw new OqtoAppError("invalid", "hostOrigin must be an absolute URL origin", { cause: error });
  }
  if (url.origin === "null" || url.origin.includes("*")) {
    throw new OqtoAppError("invalid", "hostOrigin must be an exact non-opaque origin");
  }
  if (explicit !== undefined && url.href !== `${url.origin}/` && url.href !== url.origin) {
    throw new OqtoAppError("invalid", "hostOrigin must not contain a path, query, or fragment");
  }
  return url.origin;
}

function newNonce(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(24);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  throw new OqtoAppError("unsupported", "Secure randomness is required for the Oqto host handshake");
}
