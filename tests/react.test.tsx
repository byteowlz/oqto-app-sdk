// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { OqtoHost, OqtoOperationResult, OqtoPresentationContext } from "../src/index.js";
import {
  OqtoHostProvider,
  useOqtoGrants,
  useOqtoOperation,
  useOqtoPresentation,
  useOqtoSuspension,
  useOqtoTheme,
} from "../src/react.js";
import { createTestHost, type OqtoTestHost } from "../src/testing.js";
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

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root && container) {
    const current = root;
    act(() => current.unmount());
    container.remove();
  }
  root = undefined;
  container = undefined;
});

/** Render a hook inside a provider and expose its latest value. */
async function renderHook<T>(host: OqtoHost, useHook: () => T): Promise<{ current: () => T }> {
  let latest: T;
  function Probe() {
    latest = useHook();
    return null;
  }
  container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(
      <StrictMode>
        <OqtoHostProvider host={host}>
          <Probe />
        </OqtoHostProvider>
      </StrictMode>,
    );
  });
  return { current: () => latest };
}

function hostWith(options: Parameters<typeof createTestHost>[0] = {}): {
  test: OqtoTestHost;
  host: OqtoHost;
} {
  const test = createTestHost(options);
  return { test, host: test.connect() };
}

describe("react bindings", () => {
  it("exposes the grant snapshot without a round trip", async () => {
    const { host } = hostWith({ operations: [{ id: "demo.run", summary: "Run" }] });
    const hook = await renderHook(host, useOqtoGrants);

    expect(hook.current().operations).toEqual([{ id: "demo.run", summary: "Run" }]);
    expect(hook.current().capabilities).toContain("operations");
  });

  it("tracks live theme updates", async () => {
    const { test, host } = hostWith({ theme: { colorScheme: "dark", tokens: {} } });
    const hook = await renderHook(host, useOqtoTheme);
    await act(async () => {
      await settle();
    });
    expect(hook.current()?.colorScheme).toBe("dark");

    await act(async () => {
      test.setTheme({ colorScheme: "light", tokens: { "--oqto-bg": "#fff" } });
      await settle();
    });

    expect(hook.current()).toEqual({ colorScheme: "light", tokens: { "--oqto-bg": "#fff" } });
  });

  it("seeds container geometry from the mount and follows resizes", async () => {
    const { test, host } = hostWith();
    const hook = await renderHook(host, useOqtoPresentation);

    // The mount snapshot is available before any async read resolves.
    expect(hook.current()?.surface).toBe("container");

    await act(async () => {
      test.setPresentation(PHONE);
      await settle();
    });

    expect(hook.current()).toEqual(PHONE);
  });

  it("surfaces suspension so a tree can stop offering actions", async () => {
    const { test, host } = hostWith();
    const hook = await renderHook(host, useOqtoSuspension);
    expect(hook.current()).toBeUndefined();

    await act(async () => {
      test.suspend({ reason: "revoked" });
      await settle();
    });

    expect(hook.current()).toEqual({ reason: "revoked" });
  });

  it("reports suspension immediately when it happened before mount", async () => {
    const { test, host } = hostWith();
    test.suspend({ reason: "uninstalled" });
    await settle();

    const hook = await renderHook(host, useOqtoSuspension);

    expect(hook.current()).toEqual({ reason: "uninstalled" });
  });

  it("moves an operation through pending to result", async () => {
    let release: ((result: OqtoOperationResult) => void) | undefined;
    const { host } = hostWith({
      operations: [
        {
          id: "demo.slow",
          handler: () =>
            new Promise<OqtoOperationResult>((resolve) => {
              release = resolve;
            }),
        },
      ],
    });
    const hook = await renderHook(host, () => useOqtoOperation("demo.slow"));

    let invocation: Promise<OqtoOperationResult> | undefined;
    await act(async () => {
      invocation = hook.current().invoke({ prompt: "hello" });
      await settle();
    });
    expect(hook.current().pending).toBe(true);

    await act(async () => {
      release?.({ ok: true, output: { jobId: "job-1" } });
      await invocation;
      await settle();
    });

    expect(hook.current().pending).toBe(false);
    expect(hook.current().result).toEqual({ ok: true, output: { jobId: "job-1" } });
    expect(hook.current().error).toBeUndefined();
  });

  it("keeps an operation failure as a result rather than an error", async () => {
    const { host } = hostWith({
      operations: [
        {
          id: "demo.fail",
          handler: () => ({ ok: false, reason: "failed", code: "nope", message: "no" }) as const,
        },
      ],
    });
    const hook = await renderHook(host, () => useOqtoOperation("demo.fail"));

    await act(async () => {
      await hook.current().invoke();
      await settle();
    });

    expect(hook.current().result).toMatchObject({ ok: false, code: "nope" });
    expect(hook.current().error).toBeUndefined();
  });

  it("records a suspension as an operation error", async () => {
    const { test, host } = hostWith({ operations: [{ id: "demo.echo" }] });
    const hook = await renderHook(host, () => useOqtoOperation("demo.echo"));

    await act(async () => {
      test.suspend({ reason: "revoked" });
      await settle();
      await hook
        .current()
        .invoke()
        .catch(() => undefined);
      await settle();
    });

    expect(hook.current().error).toBeInstanceOf(Error);
    expect(hook.current().result).toBeUndefined();
  });

  it("ignores a superseded invocation so a stale result cannot win", async () => {
    const releases: ((result: OqtoOperationResult) => void)[] = [];
    const { host } = hostWith({
      operations: [
        {
          id: "demo.race",
          handler: () =>
            new Promise<OqtoOperationResult>((resolve) => {
              releases.push(resolve);
            }),
        },
      ],
    });
    const hook = await renderHook(host, () => useOqtoOperation("demo.race"));

    const settled: OqtoOperationResult[] = [];
    await act(async () => {
      void hook
        .current()
        .invoke({ seq: 1 })
        .then((result) => settled.push(result))
        .catch(() => undefined);
      await settle();
      void hook
        .current()
        .invoke({ seq: 2 })
        .then((result) => settled.push(result))
        .catch(() => undefined);
      await settle();
    });

    await act(async () => {
      // Resolve the superseded call last; it must not overwrite the newer state.
      releases[1]?.({ ok: true, output: { seq: 2 } });
      releases[0]?.({ ok: true, output: { seq: 1 } });
      await settle();
    });

    expect(hook.current().result).toEqual({ ok: true, output: { seq: 2 } });
    expect(settled).toContainEqual({ ok: true, output: { seq: 1 } });
  });

  it("resets state on demand", async () => {
    const { host } = hostWith({ operations: [{ id: "demo.echo" }] });
    const hook = await renderHook(host, () => useOqtoOperation("demo.echo"));

    await act(async () => {
      await hook.current().invoke({ a: 1 });
      await settle();
    });
    expect(hook.current().result).toBeDefined();

    await act(async () => {
      hook.current().reset();
    });

    expect(hook.current().result).toBeUndefined();
    expect(hook.current().pending).toBe(false);
  });

  it("throws a clear error when used outside a provider", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const created = createRoot(container, {
      // Keep the expected failure from polluting the run's stderr.
      onUncaughtError: () => undefined,
      onRecoverableError: () => undefined,
    });
    root = created;
    function Orphan() {
      useOqtoGrants();
      return null;
    }

    let message: string | undefined;
    try {
      await act(async () => {
        created.render(<Orphan />);
      });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }

    expect(message).toContain("OqtoHostProvider");
  });
});
