import { describe, expect, it, vi } from "vitest";
import { OQTO_APP_PROTOCOL } from "../src/index.js";
import type { OqtoAppError, OqtoHostContext, OqtoUnsubscribe } from "../src/index.js";
import { serveOqtoAppPort } from "../src/host.js";
import { createTestHost } from "../src/testing.js";

const context: OqtoHostContext = {
  protocol: OQTO_APP_PROTOCOL,
  instanceId: "instance",
  installationId: "installation",
  definitionId: "definition",
  capabilities: ["files"],
};

interface RawResult {
  readonly ok: boolean;
  readonly error?: { readonly code?: string };
}

function request(port: MessagePort, id: number, method: string, params: unknown): Promise<RawResult> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (
        typeof value !== "object" ||
        value === null ||
        !("id" in value) ||
        value.id !== id ||
        !("ok" in value) ||
        typeof value.ok !== "boolean"
      ) {
        return;
      }
      port.removeEventListener("message", listener);
      resolve(value as RawResult);
    };
    port.addEventListener("message", listener);
    port.start();
    port.postMessage({ protocol: OQTO_APP_PROTOCOL, kind: "request", id, method, params });
  });
}

describe("host adapter", () => {
  it("fails before handshake when a granted capability has no implementation", () => {
    const channel = new MessageChannel();
    expect(() => serveOqtoAppPort({ context }, channel.port1)).toThrowError(
      expect.objectContaining<Partial<OqtoAppError>>({ code: "invalid" }),
    );
    channel.port1.close();
    channel.port2.close();
  });

  it("rejects an unsupported protocol", () => {
    const channel = new MessageChannel();
    const wrong = { ...context, protocol: "oqto-app/v99" } as unknown as OqtoHostContext;
    expect(() => serveOqtoAppPort({ context: wrong }, channel.port1)).toThrowError(
      expect.objectContaining<Partial<OqtoAppError>>({ code: "unsupported" }),
    );
    channel.port1.close();
    channel.port2.close();
  });

  it("enforces grants at the trusted host even for a raw malicious client", async () => {
    const full = createTestHost({ files: [{ id: "secret", bytes: "private" }] }).adapter;
    const adapter = { ...full, context: { ...full.context, capabilities: [] } };
    const channel = new MessageChannel();
    const bridge = serveOqtoAppPort(adapter, channel.port1);

    const result = await request(channel.port2, 1, "files.read", { ref: "oqto-test:secret" });
    expect(result).toMatchObject({ ok: false, error: { code: "denied" } });

    bridge.close();
    channel.port2.close();
  });

  it("releases a watcher that resolves after bridge close", async () => {
    const base = createTestHost({ files: [{ id: "scene", bytes: "{}" }] }).adapter;
    if (!base.files) throw new Error("Test requires files adapter");
    let finishWatch: ((unsubscribe: OqtoUnsubscribe) => void) | undefined;
    const unsubscribe = vi.fn();
    const adapter = {
      ...base,
      context: { ...base.context, capabilities: ["files"] as const },
      files: {
        ...base.files,
        watch: () =>
          new Promise<OqtoUnsubscribe>((resolve) => {
            finishWatch = resolve;
          }),
      },
    };
    const channel = new MessageChannel();
    const bridge = serveOqtoAppPort(adapter, channel.port1);
    channel.port2.postMessage({
      protocol: OQTO_APP_PROTOCOL,
      kind: "request",
      id: 1,
      method: "files.watch.start",
      params: { ref: "oqto-test:scene", subscriptionId: "watch-1" },
    });
    await vi.waitFor(() => expect(finishWatch).toBeTypeOf("function"));

    bridge.close();
    finishWatch?.(unsubscribe);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    channel.port2.close();
  });

  it("bounds subscriptions independently of request concurrency", async () => {
    const test = createTestHost({ files: [{ id: "scene", bytes: "{}" }] });
    const channel = new MessageChannel();
    const bridge = serveOqtoAppPort(test.adapter, channel.port1, { maxSubscriptions: 1 });

    const first = await request(channel.port2, 1, "files.watch.start", {
      ref: "oqto-test:scene",
      subscriptionId: "watch-1",
    });
    expect(first.ok).toBe(true);
    const second = await request(channel.port2, 2, "files.watch.start", {
      ref: "oqto-test:scene",
      subscriptionId: "watch-2",
    });
    expect(second).toMatchObject({ ok: false, error: { code: "quota_exceeded" } });

    bridge.close();
    channel.port2.close();
  });

  it("reserves subscription ids before awaiting the host watcher", async () => {
    const base = createTestHost({ files: [{ id: "scene", bytes: "{}" }] }).adapter;
    if (!base.files) throw new Error("Test requires files adapter");
    let finishWatch: ((unsubscribe: OqtoUnsubscribe) => void) | undefined;
    const watch = vi.fn(
      () =>
        new Promise<OqtoUnsubscribe>((resolve) => {
          finishWatch = resolve;
        }),
    );
    const adapter = {
      ...base,
      context: { ...base.context, capabilities: ["files"] as const },
      files: { ...base.files, watch },
    };
    const channel = new MessageChannel();
    const bridge = serveOqtoAppPort(adapter, channel.port1);
    const params = { ref: "oqto-test:scene", subscriptionId: "duplicate" };

    channel.port2.postMessage({
      protocol: OQTO_APP_PROTOCOL,
      kind: "request",
      id: 1,
      method: "files.watch.start",
      params,
    });
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
    const duplicate = await request(channel.port2, 2, "files.watch.start", params);
    expect(duplicate).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(watch).toHaveBeenCalledOnce();

    finishWatch?.(() => undefined);
    bridge.close();
    channel.port2.close();
  });
});
