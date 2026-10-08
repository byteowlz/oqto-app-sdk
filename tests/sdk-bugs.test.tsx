// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { OqtoOperationResult } from "../src/index.js";
import { OqtoHostProvider, useOqtoOperation } from "../src/react.js";
import { createTestHost } from "../src/testing.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("clears pending when cancelling a running cooperative operation", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const test = createTestHost({
    operations: [
      {
        id: "probe.cancel",
        handler: (_input, signal) =>
          new Promise((resolve) => {
            started();
            signal.addEventListener(
              "abort",
              () => resolve({ ok: false, reason: "failed", code: "cancelled", message: "cancelled" }),
              { once: true },
            );
          }),
      },
    ],
  });
  const host = test.connect();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let current!: ReturnType<typeof useOqtoOperation>;
  function Probe() {
    current = useOqtoOperation("probe.cancel");
    return null;
  }
  try {
    await act(async () => {
      root.render(
        <OqtoHostProvider host={host}>
          <Probe />
        </OqtoHostProvider>,
      );
    });
    let invocation!: ReturnType<typeof current.invoke>;
    await act(async () => {
      invocation = current.invoke();
      await entered;
    });
    expect(current.pending).toBe(true);
    await act(async () => {
      current.cancel();
      await invocation;
    });
    expect(current.pending).toBe(false);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

type Hook = ReturnType<typeof useOqtoOperation>;

/** Mount one useOqtoOperation probe against a real MessageChannel test host. */
async function mountProbe(handler: (input: unknown, signal: AbortSignal) => Promise<OqtoOperationResult>) {
  const test = createTestHost({ operations: [{ id: "probe.op", handler }] });
  const host = test.connect();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const probe: { current?: Hook } = {};
  function Probe() {
    probe.current = useOqtoOperation("probe.op");
    return null;
  }
  await act(async () => {
    root.render(
      <OqtoHostProvider host={host}>
        <Probe />
      </OqtoHostProvider>,
    );
  });
  const hook = (): Hook => {
    if (!probe.current) throw new Error("probe not rendered");
    return probe.current;
  };
  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
  return { hook, unmount };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok = (value: string): OqtoOperationResult => ({ ok: true, output: value });

it("clears pending when cancelled before the host dispatches", async () => {
  const { hook, unmount } = await mountProbe(() => Promise.resolve(ok("late")));
  try {
    await act(async () => {
      const invocation = hook().invoke();
      hook().cancel();
      await invocation.catch(() => undefined);
    });
    expect(hook().pending).toBe(false);
    expect(hook().result).toBeUndefined();
    expect(hook().error).toBeUndefined();
  } finally {
    await unmount();
  }
});

it("ignores a late result that arrives after cancel", async () => {
  const gate = deferred<OqtoOperationResult>();
  const entered = deferred<void>();
  const { hook, unmount } = await mountProbe(() => {
    entered.resolve();
    return gate.promise; // uncooperative: ignores the abort signal
  });
  try {
    let invocation!: Promise<unknown>;
    await act(async () => {
      invocation = hook()
        .invoke()
        .catch(() => undefined);
      await entered.promise;
    });
    await act(async () => {
      hook().cancel();
    });
    expect(hook().pending).toBe(false);
    await act(async () => {
      gate.resolve(ok("late"));
      await invocation;
    });
    expect(hook().pending).toBe(false);
    expect(hook().result).toBeUndefined();
  } finally {
    await unmount();
  }
});

it("keeps only the newest overlapping invocation's result", async () => {
  // A superseded invocation is aborted, possibly before dispatch, so the
  // handler may run once or twice; record whatever is actually dispatched.
  const gates: ReturnType<typeof deferred<OqtoOperationResult>>[] = [];
  const { hook, unmount } = await mountProbe(() => {
    const gate = deferred<OqtoOperationResult>();
    gates.push(gate);
    return gate.promise;
  });
  try {
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = hook()
        .invoke()
        .catch(() => undefined);
      second = hook()
        .invoke()
        .catch(() => undefined);
    });
    const newest = gates.at(-1);
    if (!newest) throw new Error("no invocation dispatched");
    await act(async () => {
      newest.resolve(ok("second"));
      await second;
    });
    expect(hook().pending).toBe(false);
    expect(hook().result).toEqual(ok("second"));
    await act(async () => {
      for (const gate of gates.slice(0, -1)) gate.resolve(ok("first"));
      await first;
    });
    expect(hook().result).toEqual(ok("second"));
  } finally {
    await unmount();
  }
});

it("does not update state after unmount while an operation is running", async () => {
  const gate = deferred<OqtoOperationResult>();
  const entered = deferred<void>();
  const { hook, unmount } = await mountProbe(() => {
    entered.resolve();
    return gate.promise;
  });
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    let invocation!: Promise<unknown>;
    await act(async () => {
      invocation = hook()
        .invoke()
        .catch(() => undefined);
      await entered.promise;
    });
    await unmount();
    gate.resolve(ok("late"));
    await invocation;
    expect(errors).toEqual([]);
  } finally {
    console.error = original;
  }
});
