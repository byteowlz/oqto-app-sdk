import { describe, expect, it } from "vitest";
import type { OqtoHost, OqtoPresentationCapability, OqtoPresentationContext } from "../src/index.js";
import { createTestHost } from "../src/testing.js";
import { settle } from "./settle.js";

const PHONE: OqtoPresentationContext = {
  surface: "container",
  width: 390,
  height: 844,
  sizeClass: "compact",
  density: "compact",
  safeArea: { top: 47, right: 0, bottom: 34, left: 0 },
  reducedMotion: true,
};

function requirePresentation(host: OqtoHost): OqtoPresentationCapability {
  if (!host.presentation) throw new Error("Test requires the presentation capability");
  return host.presentation;
}

describe("presentation context", () => {
  it("describes the container rather than the viewport", async () => {
    const test = createTestHost({ presentation: PHONE });
    const host = test.connect();

    expect(host.context.presentation).toEqual(PHONE);
    expect(await requirePresentation(host).get()).toEqual(PHONE);
  });

  it("emits container updates so an App can reflow on resize", async () => {
    const test = createTestHost();
    const host = test.connect();
    const seen: OqtoPresentationContext[] = [];
    await requirePresentation(host).watch((context) => seen.push(context));

    test.setPresentation(PHONE);
    await settle();

    expect(seen).toEqual([PHONE]);
  });

  it("stops emitting after unsubscribe", async () => {
    const test = createTestHost();
    const host = test.connect();
    const seen: OqtoPresentationContext[] = [];
    const stop = await requirePresentation(host).watch((context) => seen.push(context));

    stop();
    test.setPresentation(PHONE);
    await settle();

    expect(seen).toEqual([]);
  });

  it("rejects a malformed context instead of guessing a size", async () => {
    const test = createTestHost();
    const host = test.connect();
    // A negative width would silently break responsive branching downstream.
    expect(() => test.setPresentation({ ...PHONE, width: -1 })).not.toThrow();
    await expect(requirePresentation(host).get()).rejects.toMatchObject({ code: "invalid" });
  });

  it("is absent when the capability is not granted", () => {
    const host = createTestHost({ capabilities: ["theme"] }).connect();
    expect(host.presentation).toBeUndefined();
    expect(host.context.presentation).toBeDefined();
  });
});
