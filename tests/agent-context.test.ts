import { describe, expect, it, vi } from "vitest";
import { OqtoAppError } from "../src/errors.js";
import { serveOqtoAppPort } from "../src/host.js";
import { connectOqtoAppPort } from "../src/internal/rpc-client.js";
import {
  type JsonValue,
  OQTO_APP_PROTOCOL_V1,
  OQTO_APP_PROTOCOL_V2,
  type OqtoAgentContextCatalog,
  type OqtoContextChange,
  type OqtoContextSnapshot,
  type OqtoHostContext,
} from "../src/types.js";

const catalog: OqtoAgentContextCatalog = {
  providerId: "app-instance:gallery-1",
  topics: [
    {
      id: "gallery.selection",
      title: "Selected images",
      schemaVersion: "gallery.selection/v1",
      lifetime: "session_local",
      disclosure: "explicit_intent",
    },
  ],
  actions: [
    {
      id: "gallery.selection.clear",
      title: "Clear selection",
      requiredTopics: ["gallery.selection"],
      requiresUserActivation: false,
    },
  ],
};

function context(protocol: OqtoHostContext["protocol"] = OQTO_APP_PROTOCOL_V2): OqtoHostContext {
  return {
    protocol,
    instanceId: "gallery-1",
    installationId: "gallery-installation",
    definitionId: "gallery-definition",
    capabilities: ["agent_context"],
    grants: { capabilities: ["agent_context"], resources: [], operations: [] },
  };
}

function connected() {
  const channel = new MessageChannel();
  let revision = 0;
  let current: OqtoContextSnapshot | undefined;
  const listeners = new Set<(change: OqtoContextChange) => void>();
  const publish = vi.fn(async (topic: string, value: JsonValue) => {
    revision += 1;
    current = {
      providerId: catalog.providerId,
      topic,
      revision,
      updatedAt: "2026-09-01T00:00:00Z",
      value,
    };
    for (const listener of listeners) listener({ snapshot: current, generation: revision, gap: false });
    return current;
  });
  const bridge = serveOqtoAppPort(
    {
      context: context(),
      agent_context: {
        catalog: async () => catalog,
        get: async (topic) => (current?.topic === topic ? current : undefined),
        publish,
        clear: async () => {
          current = undefined;
        },
        watch: async (_topics, listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        invokeAction: async (_id, expected) =>
          expected === revision
            ? { ok: true, output: null }
            : { ok: false, reason: "stale_context", currentRevision: revision },
      },
    },
    channel.port1,
  );
  const host = connectOqtoAppPort(context(), channel.port2);
  return { bridge, host, publish };
}

describe("App-defined Agent Context", () => {
  it("publishes unfamiliar typed domain state without a platform enumeration", async () => {
    const { bridge, host, publish } = connected();
    expect(await host.agentContext?.catalog()).toEqual(catalog);
    await expect(
      host.agentContext?.publish("gallery.selection", {
        selected_refs: ["image:81", "image:92"],
        primary_ref: "image:92",
      }),
    ).resolves.toMatchObject({ topic: "gallery.selection", revision: 1 });
    expect(publish).toHaveBeenCalledOnce();
    bridge.close();
    host.close();
  });

  it("reports stale revision outcomes without mutating through context", async () => {
    const { bridge, host } = connected();
    await host.agentContext?.publish("gallery.selection", { selected_refs: ["image:81"] });
    await expect(host.agentContext?.invokeAction("gallery.selection.clear", 0)).resolves.toEqual({
      ok: false,
      reason: "stale_context",
      currentRevision: 1,
    });
    await expect(host.agentContext?.invokeAction("gallery.selection.clear", 1)).resolves.toEqual({
      ok: true,
      output: null,
    });
    bridge.close();
    host.close();
  });

  it("derives an explicit gap when subscription generations jump", async () => {
    const channel = new MessageChannel();
    let emit: ((change: OqtoContextChange) => void) | undefined;
    const bridge = serveOqtoAppPort(
      {
        context: context(),
        agent_context: {
          catalog: async () => catalog,
          get: async () => undefined,
          publish: async () => {
            throw new Error("unused");
          },
          clear: async () => undefined,
          watch: async (_topics, listener) => {
            emit = listener;
            return () => undefined;
          },
          invokeAction: async () => ({ ok: true, output: null }),
        },
      },
      channel.port1,
    );
    const host = connectOqtoAppPort(context(), channel.port2);
    const changes: OqtoContextChange[] = [];
    const stop = await host.agentContext?.watch(["gallery.selection"], (change) => changes.push(change));
    const snapshot = {
      providerId: catalog.providerId,
      topic: "gallery.selection",
      revision: 1,
      updatedAt: "2026-09-01T00:00:00Z",
      value: null,
    } as const;
    emit?.({ snapshot, generation: 1, gap: false });
    emit?.({ snapshot: { ...snapshot, revision: 3 }, generation: 3, gap: false });
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes[1]?.gap).toBe(true);
    stop?.();
    bridge.close();
    host.close();
  });

  it("rejects Agent Context on a v1 mount and after revocation", async () => {
    const oldChannel = new MessageChannel();
    const oldHost = connectOqtoAppPort(context(OQTO_APP_PROTOCOL_V1), oldChannel.port1);
    await expect(oldHost.agentContext?.catalog()).rejects.toMatchObject({ code: "unsupported" });
    oldHost.close();
    oldChannel.port2.close();

    const { bridge, host, publish } = connected();
    bridge.suspend({ reason: "revoked" });
    await expect(host.suspension).resolves.toEqual({ reason: "revoked" });
    await expect(host.agentContext?.publish("gallery.selection", null)).rejects.toMatchObject({
      code: "suspended",
    });
    expect(publish).not.toHaveBeenCalled();
    host.close();
  });

  it("rejects non-JSON values before they reach the adapter", async () => {
    const { bridge, host, publish } = connected();
    await expect(
      host.agentContext?.publish("gallery.selection", { bad: Number.NaN } as unknown as JsonValue),
    ).rejects.toBeInstanceOf(OqtoAppError);
    expect(publish).not.toHaveBeenCalled();
    bridge.close();
    host.close();
  });
});
