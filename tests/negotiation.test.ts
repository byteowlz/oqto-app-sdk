import { afterEach, describe, expect, it, vi } from "vitest";
import { attachOqtoAppFrame } from "../src/host.js";
import {
  connectOqtoApp,
  OQTO_APP_PROTOCOL,
  OQTO_APP_PROTOCOL_V1,
  OQTO_APP_PROTOCOL_V2,
  OQTO_APP_PROTOCOL_VERSIONS,
} from "../src/index.js";
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

interface AttachProbe {
  readonly parent: EventTarget;
  readonly frame: { postMessage(message: unknown, target: string, ports: Transferable[]): void };
  readonly transferred: MessagePort[];
  sent(): unknown;
}

function attachProbe(): AttachProbe {
  const parent = new EventTarget();
  const transferred: MessagePort[] = [];
  let sent: unknown;
  const frame = {
    postMessage(message: unknown, _target: string, ports: Transferable[]) {
      sent = message;
      transferred.push(...ports.filter((port): port is MessagePort => port instanceof MessagePort));
    },
  };
  return { parent, frame, transferred, sent: () => sent };
}

afterEach(() => vi.unstubAllGlobals());

describe("protocol negotiation", () => {
  it("selects the newest version both sides offer", async () => {
    const probe = attachProbe();
    const attaching = attachOqtoAppFrame({
      frameWindow: probe.frame as unknown as WindowProxy,
      appOrigin: "https://app.example.test",
      adapter: createTestHost().adapter,
      parentWindow: probe.parent as unknown as Window,
    });

    probe.parent.dispatchEvent(
      messageEvent({
        data: {
          protocol: OQTO_APP_PROTOCOL,
          kind: "oqto.app.ready",
          nonce: "n",
          supportedVersions: [...OQTO_APP_PROTOCOL_VERSIONS],
        },
        origin: "https://app.example.test",
        source: probe.frame,
      }),
    );
    const bridge = await attaching;

    expect(bridge.protocol).toBe(OQTO_APP_PROTOCOL_V2);
    expect(probe.sent()).toMatchObject({ protocol: OQTO_APP_PROTOCOL_V2 });
    probe.transferred[0]?.close();
    bridge.close();
  });

  it("downgrades to the version an older host pins", async () => {
    const probe = attachProbe();
    const attaching = attachOqtoAppFrame({
      frameWindow: probe.frame as unknown as WindowProxy,
      appOrigin: "https://app.example.test",
      adapter: createTestHost().adapter,
      parentWindow: probe.parent as unknown as Window,
      supportedVersions: [OQTO_APP_PROTOCOL],
    });

    probe.parent.dispatchEvent(
      messageEvent({
        data: {
          protocol: OQTO_APP_PROTOCOL,
          kind: "oqto.app.ready",
          nonce: "n",
          supportedVersions: [...OQTO_APP_PROTOCOL_VERSIONS],
        },
        origin: "https://app.example.test",
        source: probe.frame,
      }),
    );
    const bridge = await attaching;

    expect(bridge.protocol).toBe(OQTO_APP_PROTOCOL);
    probe.transferred[0]?.close();
    bridge.close();
  });

  it("fails closed when the App offers only versions the host refuses", async () => {
    const probe = attachProbe();
    const attaching = attachOqtoAppFrame({
      frameWindow: probe.frame as unknown as WindowProxy,
      appOrigin: "https://app.example.test",
      adapter: createTestHost().adapter,
      parentWindow: probe.parent as unknown as Window,
      supportedVersions: [OQTO_APP_PROTOCOL_V1],
    });

    probe.parent.dispatchEvent(
      messageEvent({
        data: {
          protocol: OQTO_APP_PROTOCOL,
          kind: "oqto.app.ready",
          nonce: "n",
          supportedVersions: ["oqto-app/v0"],
        },
        origin: "https://app.example.test",
        source: probe.frame,
      }),
    );

    await expect(attaching).rejects.toMatchObject({ code: "unsupported" });
  });

  it("refuses a host that answers with a version the App never offered", async () => {
    const childEvents = new EventTarget();
    const adapter = createTestHost({ capabilities: ["theme"] }).adapter;
    const parent = {
      postMessage(message: unknown) {
        if (typeof message !== "object" || message === null || !("nonce" in message)) return;
        queueMicrotask(() => {
          childEvents.dispatchEvent(
            messageEvent({
              data: {
                protocol: OQTO_APP_PROTOCOL_V1,
                kind: "oqto.app.connect",
                nonce: message.nonce,
                context: { ...adapter.context, protocol: OQTO_APP_PROTOCOL_V1 },
              },
              origin: "https://oqto.example.test",
              source: parent,
              ports: [new MessageChannel().port2],
            }),
          );
        });
      },
    };
    vi.stubGlobal("window", {
      parent,
      addEventListener: childEvents.addEventListener.bind(childEvents),
      removeEventListener: childEvents.removeEventListener.bind(childEvents),
    });
    vi.stubGlobal("document", { referrer: "https://oqto.example.test/oqto-ui" });

    await expect(connectOqtoApp({ supportedVersions: [OQTO_APP_PROTOCOL] })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("rejects an empty version offer rather than silently using the default", async () => {
    vi.stubGlobal("window", {
      parent: { postMessage() {} },
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal("document", { referrer: "https://oqto.example.test" });

    await expect(connectOqtoApp({ supportedVersions: [] as never })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("keeps v1-only capabilities unreachable on a v0 mount", async () => {
    const test = createTestHost({
      files: [{ id: "doc", bytes: "hi" }],
      operations: [{ id: "demo.run" }],
    });
    const host = test.connect({ protocol: OQTO_APP_PROTOCOL });

    expect(host.protocol).toBe(OQTO_APP_PROTOCOL);
    // The grant snapshot degrades rather than lying about detail it cannot carry.
    expect(host.context.grants.resources).toEqual([]);
    expect(host.context.presentation).toBeUndefined();
    await expect(host.files?.resources()).rejects.toMatchObject({ code: "unsupported" });
    await expect(host.operations?.list()).rejects.toMatchObject({ code: "unsupported" });
    await expect(host.presentation?.get()).rejects.toMatchObject({ code: "unsupported" });

    // v0 methods still work on the same mount.
    expect((await host.files?.read(test.ref("doc")))?.size).toBe(2);
    host.close();
  });
});
