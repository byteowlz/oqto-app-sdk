import { afterEach, describe, expect, it, vi } from "vitest";
import { connectOqtoApp, OQTO_APP_PROTOCOL } from "../src/index.js";
import { attachOqtoAppFrame, serveOqtoAppPort } from "../src/host.js";
import { createTestHost } from "../src/testing.js";

function messageEvent(init: {
  data: unknown;
  origin: string;
  source: unknown;
  ports?: readonly MessagePort[];
}): MessageEvent<unknown> {
  const event = new Event("message") as MessageEvent<unknown>;
  Object.defineProperties(event, {
    data: { value: init.data },
    origin: { value: init.origin },
    source: { value: init.source },
    ports: { value: init.ports ?? [] },
  });
  return event;
}

afterEach(() => vi.unstubAllGlobals());

describe("iframe handshake", () => {
  it("is promise-safe outside a browser", async () => {
    await expect(connectOqtoApp()).rejects.toMatchObject({ code: "unsupported" });
  });

  it("echoes the readiness nonce and transfers one private port to the exact app origin", async () => {
    const parent = new EventTarget();
    const transferred: MessagePort[] = [];
    let sent: unknown;
    let targetOrigin: string | undefined;
    const frame = {
      postMessage(message: unknown, target: string, ports: Transferable[]) {
        sent = message;
        targetOrigin = target;
        transferred.push(...ports.filter((port): port is MessagePort => port instanceof MessagePort));
      },
    };
    const adapter = createTestHost().adapter;
    const attaching = attachOqtoAppFrame({
      frameWindow: frame as unknown as WindowProxy,
      appOrigin: "https://hash.apps.example.test",
      adapter,
      parentWindow: parent as unknown as Window,
    });

    parent.dispatchEvent(
      messageEvent({
        data: { protocol: OQTO_APP_PROTOCOL, kind: "oqto.app.ready", nonce: "nonce-1" },
        origin: "https://hash.apps.example.test",
        source: frame,
      }),
    );
    const bridge = await attaching;

    expect(targetOrigin).toBe("https://hash.apps.example.test");
    // This readiness message carries no version offer, exactly as a bundle
    // built against the first SDK release would, so the host must fall back to
    // v0 rather than assuming the newer contract.
    expect(sent).toMatchObject({
      kind: "oqto.app.connect",
      nonce: "nonce-1",
      protocol: OQTO_APP_PROTOCOL,
      context: { ...adapter.context, protocol: OQTO_APP_PROTOCOL },
    });
    expect(bridge.protocol).toBe(OQTO_APP_PROTOCOL);
    expect(transferred).toHaveLength(1);
    transferred[0]?.close();
    bridge.close();
  });

  it("connects only to the exact parent and then uses the transferred port", async () => {
    const childEvents = new EventTarget();
    const adapter = createTestHost({ capabilities: ["theme"] }).adapter;
    let bridge: ReturnType<typeof serveOqtoAppPort> | undefined;
    const parent = {
      postMessage(message: unknown, targetOrigin: string) {
        if (targetOrigin !== "https://oqto.example.test") throw new Error("wrong target origin");
        if (typeof message !== "object" || message === null || !("nonce" in message)) return;
        const stray = new MessageChannel();
        const channel = new MessageChannel();
        bridge = serveOqtoAppPort(adapter, channel.port1);
        queueMicrotask(() => {
          childEvents.dispatchEvent(
            messageEvent({
              data: {
                protocol: adapter.context.protocol,
                kind: "oqto.app.connect",
                nonce: "some-other-handshake",
                context: adapter.context,
              },
              origin: "https://oqto.example.test",
              source: parent,
              ports: [stray.port2],
            }),
          );
          stray.port1.close();
          childEvents.dispatchEvent(
            messageEvent({
              data: {
                protocol: adapter.context.protocol,
                kind: "oqto.app.connect",
                nonce: message.nonce,
                context: adapter.context,
              },
              origin: "https://oqto.example.test",
              source: parent,
              ports: [channel.port2],
            }),
          );
        });
      },
    };
    const child = {
      parent,
      addEventListener: childEvents.addEventListener.bind(childEvents),
      removeEventListener: childEvents.removeEventListener.bind(childEvents),
    };
    vi.stubGlobal("window", child);
    vi.stubGlobal("document", { referrer: "https://oqto.example.test/oqto-ui" });

    const host = await connectOqtoApp();
    expect(await host.theme?.get()).toEqual({ colorScheme: "dark", tokens: {} });

    host.close();
    bridge?.close();
  });
});
