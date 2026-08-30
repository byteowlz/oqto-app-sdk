import { describe, expect, it, vi } from "vitest";
import type {
  JsonValue,
  OqtoHost,
  OqtoKvCapability,
  OqtoNotificationsCapability,
  OqtoThemeCapability,
} from "../src/index.js";
import { createTestHost } from "../src/testing.js";

function requireCapabilities(host: OqtoHost): {
  kv: OqtoKvCapability;
  theme: OqtoThemeCapability;
  notifications: OqtoNotificationsCapability;
} {
  if (!host.kv || !host.theme || !host.notifications) throw new Error("Test requires all local capabilities");
  return { kv: host.kv, theme: host.theme, notifications: host.notifications };
}

describe("host capabilities", () => {
  it("exposes granted capabilities only", () => {
    const test = createTestHost({ capabilities: ["theme"] });
    const host = test.connect();

    expect(host.theme).toBeDefined();
    expect(host.files).toBeUndefined();
    expect(host.kv).toBeUndefined();
    expect(host.notifications).toBeUndefined();
  });

  it("round-trips JSON KV and rejects non-finite values at the host seam", async () => {
    const { kv } = requireCapabilities(createTestHost().connect());
    const value = { nested: [1, true, null, "ok"] } as const;

    await kv.set("prefs", value);
    expect(await kv.get("prefs")).toEqual(value);
    const shared = { inherited: true };
    await kv.set("shared", { primary: shared, fallback: shared });
    expect(await kv.get("shared")).toEqual({ primary: shared, fallback: shared });
    await kv.delete("prefs");
    expect(await kv.get("prefs")).toBeUndefined();

    await expect(kv.set("invalid", Number.NaN as JsonValue)).rejects.toMatchObject({ code: "invalid" });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(kv.set("cyclic", cyclic as JsonValue)).rejects.toMatchObject({ code: "invalid" });
    await expect(kv.set("huge", "x".repeat(300_000))).rejects.toMatchObject({ code: "too_large" });
  });

  it("delivers theme changes and records notifications", async () => {
    const test = createTestHost();
    const { theme, notifications } = requireCapabilities(test.connect());
    const themes: string[] = [];
    const unsubscribe = await theme.watch((value) => themes.push(value.colorScheme));

    test.setTheme({ colorScheme: "light", tokens: { "--oqto-bg": "#fff" } });
    await vi.waitFor(() => expect(themes).toEqual(["light"]));
    unsubscribe();

    await notifications.notify({ level: "success", message: "Saved" });
    expect(test.notifications).toEqual([{ level: "success", message: "Saved" }]);
  });

  it("closes all active sessions deterministically", async () => {
    const test = createTestHost();
    const first = test.connect();
    const second = test.connect();

    test.close();
    await expect(first.closed).resolves.toBe("host");
    await expect(second.closed).resolves.toBe("host");
  });
});
