import { describe, expect, it } from "vitest";
import type { OqtoSuspension } from "../src/index.js";
import { createTestHost } from "../src/testing.js";
import { settle } from "./settle.js";

const REVOKED: OqtoSuspension = { reason: "revoked", message: "Access was withdrawn" };

describe("suspension and revocation", () => {
  it("rejects a call that was already in flight", async () => {
    let release: (() => void) | undefined;
    const test = createTestHost({
      operations: [
        {
          id: "demo.slow",
          handler: () =>
            new Promise((resolve) => {
              release = () => resolve({ ok: true, output: null });
            }),
        },
      ],
    });
    const host = test.connect();

    const pending = host.operations?.invoke("demo.slow");
    await settle();
    test.suspend(REVOKED);

    await expect(pending).rejects.toMatchObject({ code: "suspended" });
    // Releasing the host handler afterwards must not resurrect the result.
    release?.();
    await expect(pending).rejects.toMatchObject({ code: "suspended" });
  });

  it("rejects later calls without reaching the host", async () => {
    const test = createTestHost({
      files: [{ id: "doc", bytes: "hello" }],
      operations: [{ id: "demo.echo" }],
    });
    const host = test.connect();
    test.suspend(REVOKED);

    await expect(host.files?.read(test.ref("doc"))).rejects.toMatchObject({ code: "suspended" });
    await expect(host.kv?.get("k")).rejects.toMatchObject({ code: "suspended" });
    await expect(host.operations?.invoke("demo.echo")).rejects.toMatchObject({ code: "suspended" });
    expect(test.invocations).toHaveLength(0);
  });

  it("reports the reason synchronously and through the promise", async () => {
    const test = createTestHost();
    const host = test.connect();
    expect(host.isSuspended()).toBeUndefined();

    test.suspend(REVOKED);
    await settle();

    // Once the notice lands, render paths can branch without awaiting.
    expect(host.isSuspended()).toEqual(REVOKED);
    await expect(host.suspension).resolves.toEqual(REVOKED);
  });

  it("notifies listeners once, including those registered afterwards", async () => {
    const test = createTestHost();
    const host = test.connect();
    const seen: OqtoSuspension[] = [];
    host.onSuspended((value) => seen.push(value));

    test.suspend(REVOKED);
    test.suspend({ reason: "uninstalled" });

    const late: OqtoSuspension[] = [];
    host.onSuspended((value) => late.push(value));
    await settle();

    expect(seen).toEqual([REVOKED]);
    expect(late).toEqual([REVOKED]);
  });

  it("stops delivering watcher events after revocation", async () => {
    const test = createTestHost({ files: [{ id: "doc", bytes: "one" }] });
    const host = test.connect();
    const changes: unknown[] = [];
    await host.files?.watch(test.ref("doc"), (change) => changes.push(change));

    test.externalWrite("doc", "two");
    test.flushFileChanges();
    await settle();
    const beforeRevocation = changes.length;

    test.suspend(REVOKED);
    test.externalWrite("doc", "three");
    test.flushFileChanges();
    await settle();

    expect(beforeRevocation).toBe(1);
    expect(changes).toHaveLength(1);
  });

  it("leaves a removed listener unnotified", () => {
    const test = createTestHost();
    const host = test.connect();
    const seen: OqtoSuspension[] = [];
    const unsubscribe = host.onSuspended((value) => seen.push(value));

    unsubscribe();
    test.suspend(REVOKED);

    expect(seen).toEqual([]);
  });
});
