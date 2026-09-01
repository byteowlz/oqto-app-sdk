import { describe, expect, it } from "vitest";
import type { JsonValue, OqtoHost, OqtoOperationsCapability } from "../src/index.js";
import { createTestHost } from "../src/testing.js";

function requireOperations(host: OqtoHost): OqtoOperationsCapability {
  if (!host.operations) throw new Error("Test requires the operations capability");
  return host.operations;
}

describe("semantic operations", () => {
  it("lists granted operations with their human summaries", async () => {
    const test = createTestHost({
      operations: [
        { id: "comfy.workflows.list", summary: "List available generation workflows" },
        { id: "comfy.generate.submit", summary: "Submit one generation job" },
      ],
    });
    const operations = requireOperations(test.connect());

    expect(await operations.list()).toEqual([
      { id: "comfy.workflows.list", summary: "List available generation workflows" },
      { id: "comfy.generate.submit", summary: "Submit one generation job" },
    ]);
  });

  it("round-trips JSON input and output", async () => {
    const test = createTestHost({
      operations: [
        {
          id: "demo.echo",
          handler: (input) => ({ ok: true, output: { received: input ?? null } }),
        },
      ],
    });
    const operations = requireOperations(test.connect());
    const input: JsonValue = { workflow: "sdxl", width: 1280, nested: [1, true, null] };

    const result = await operations.invoke("demo.echo", input);

    expect(result).toEqual({ ok: true, output: { received: input } });
    expect(test.invocations).toEqual([{ id: "demo.echo", input }]);
  });

  it("returns operation failure as a value, not an exception", async () => {
    const test = createTestHost({
      operations: [
        {
          id: "demo.fail",
          handler: () => ({
            ok: false,
            reason: "failed",
            code: "backend_unavailable",
            message: "ComfyUI is not reachable",
          }),
        },
      ],
    });
    const operations = requireOperations(test.connect());

    const result = await operations.invoke("demo.fail");

    expect(result).toEqual({
      ok: false,
      reason: "failed",
      code: "backend_unavailable",
      message: "ComfyUI is not reachable",
    });
  });

  it("refuses an operation the host did not grant", async () => {
    const test = createTestHost({ operations: [{ id: "demo.allowed" }] });
    const operations = requireOperations(test.connect());

    await expect(operations.invoke("demo.forbidden")).rejects.toMatchObject({ code: "denied" });
  });

  it("rejects unbounded input before it reaches the host", async () => {
    const test = createTestHost({ operations: [{ id: "demo.echo" }] });
    const operations = requireOperations(test.connect());
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(operations.invoke("demo.echo", cyclic as never)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(test.invocations).toHaveLength(0);
  });

  it("propagates cancellation to the host handler", async () => {
    let observed: boolean | undefined;
    const test = createTestHost({
      operations: [
        {
          id: "demo.slow",
          handler: (_input, signal) =>
            new Promise((resolve) => {
              signal.addEventListener("abort", () => {
                observed = true;
                resolve({ ok: false, reason: "failed", code: "cancelled", message: "aborted" });
              });
            }),
        },
      ],
    });
    const operations = requireOperations(test.connect());
    const controller = new AbortController();

    const pending = operations.invoke("demo.slow", null, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(observed).toBe(true);
  });

  it("refuses an invocation whose signal already aborted", async () => {
    const test = createTestHost({ operations: [{ id: "demo.echo" }] });
    const operations = requireOperations(test.connect());

    await expect(operations.invoke("demo.echo", null, { signal: AbortSignal.abort() })).rejects.toMatchObject(
      { code: "cancelled" },
    );
    expect(test.invocations).toHaveLength(0);
  });

  it("is absent entirely when the capability is not granted", () => {
    const host = createTestHost({ capabilities: ["theme"], operations: [{ id: "demo" }] }).connect();
    expect(host.operations).toBeUndefined();
  });
});
