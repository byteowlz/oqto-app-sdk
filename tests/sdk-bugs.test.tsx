// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { applyOqtoTheme } from "../src/index.js";
import { OqtoHostProvider, useOqtoOperation } from "../src/react.js";
import { createTestHost } from "../src/testing.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("withdraws tokens omitted by a replacement theme snapshot", () => {
  const doc = document.implementation.createHTMLDocument();
  const element = doc.createElement("div");
  element.style.setProperty("--app-local", "8px");
  applyOqtoTheme(element, {
    colorScheme: "dark",
    tokens: { "--oqto-bg": "black", "--oqto-accent": "red" },
  });
  applyOqtoTheme(element, { colorScheme: "light", tokens: { "--oqto-bg": "white" } });
  expect(element.style.getPropertyValue("--app-local")).toBe("8px");
  expect(element.style.getPropertyValue("--oqto-accent")).toBe("");
});

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
