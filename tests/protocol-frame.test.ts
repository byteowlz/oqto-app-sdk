import { describe, expect, it, vi } from "vitest";
import { serveOqtoAppPort } from "../src/host.js";
import { connectOqtoAppPort } from "../src/internal/rpc-client.js";
import { OQTO_APP_PROTOCOL, OQTO_APP_PROTOCOL_V1, type OqtoHostContext } from "../src/types.js";

const context: OqtoHostContext = {
  protocol: OQTO_APP_PROTOCOL_V1,
  instanceId: "instance",
  installationId: "installation",
  definitionId: "definition",
  capabilities: ["theme"],
  grants: { capabilities: ["theme"], resources: [], operations: [] },
};

describe("negotiated frame version", () => {
  it("ignores requests tagged with a different protocol", async () => {
    const channel = new MessageChannel();
    const get = vi.fn(async () => ({ colorScheme: "dark" as const, tokens: {} }));
    const bridge = serveOqtoAppPort(
      {
        context,
        theme: { get, watch: async () => () => undefined },
      },
      channel.port1,
    );
    channel.port2.start();
    channel.port2.postMessage({
      protocol: OQTO_APP_PROTOCOL,
      kind: "request",
      id: 1,
      method: "theme.get",
      params: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(get).not.toHaveBeenCalled();
    channel.port2.close();
    bridge.close();
  });

  it("ignores results tagged with a different protocol", async () => {
    const channel = new MessageChannel();
    const host = connectOqtoAppPort(context, channel.port1, { requestTimeoutMs: 500 });
    channel.port2.onmessage = (event: MessageEvent<{ id: number }>) => {
      channel.port2.postMessage({
        protocol: OQTO_APP_PROTOCOL,
        kind: "result",
        id: event.data.id,
        ok: true,
        value: { colorScheme: "light", tokens: {} },
      });
      queueMicrotask(() =>
        channel.port2.postMessage({
          protocol: OQTO_APP_PROTOCOL_V1,
          kind: "result",
          id: event.data.id,
          ok: true,
          value: { colorScheme: "dark", tokens: {} },
        }),
      );
    };
    channel.port2.start();

    await expect(host.theme?.get()).resolves.toMatchObject({ colorScheme: "dark" });
    host.close();
    channel.port2.close();
  });
});
