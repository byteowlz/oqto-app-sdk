import { describe, expect, it } from "vitest";
import type { OqtoFileChange, OqtoFilesCapability, OqtoHost } from "../src/index.js";
import { createTestHost } from "../src/testing.js";
import { settle } from "./settle.js";

function requireFiles(host: OqtoHost): OqtoFilesCapability {
  if (!host.files) throw new Error("Test requires the files capability");
  return host.files;
}

function comfyHost() {
  return createTestHost({
    files: [
      { id: "first.png", role: "first", mediaType: "image/png", access: "read", bytes: "a" },
      { id: "second.png", role: "second", mediaType: "image/png", access: "read", bytes: "bb" },
      { id: "jobs", role: "jobs", mediaType: "application/jsonl", access: "read", bytes: "{}" },
      { id: "request", role: "requests", access: "readwrite", bytes: "" },
    ],
    collections: [{ id: "outputs", role: "outputs", entries: ["first.png", "second.png"] }],
  });
}

describe("multi-resource files", () => {
  it("exposes granted resources by role without host paths", async () => {
    const test = comfyHost();
    const host = test.connect();
    const resources = await requireFiles(host).resources();

    expect(resources.map((resource) => resource.role).sort()).toEqual([
      "first",
      "jobs",
      "outputs",
      "requests",
      "second",
    ]);
    const outputs = resources.find((resource) => resource.role === "outputs");
    expect(outputs).toMatchObject({ kind: "collection", access: "read", watch: true });
    expect(JSON.stringify(resources)).not.toContain("/home/");

    // The mount-time snapshot agrees with the live read.
    expect(host.context.grants.resources).toHaveLength(resources.length);
  });

  it("enumerates a collection with an opaque cursor", async () => {
    const test = comfyHost();
    const files = requireFiles(test.connect());
    const outputs = test.ref("outputs");

    const first = await files.list(outputs, { limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.cursor).toBeDefined();

    const second = await files.list(outputs, {
      limit: 1,
      ...(first.cursor === undefined ? {} : { cursor: first.cursor }),
    });
    expect(second.entries).toHaveLength(1);
    expect(second.cursor).toBeUndefined();
    expect(second.entries[0]?.ref).not.toBe(first.entries[0]?.ref);
  });

  it("refuses to list a document", async () => {
    const test = comfyHost();
    const files = requireFiles(test.connect());

    await expect(files.list(test.ref("jobs"))).rejects.toMatchObject({ code: "gone" });
  });

  it("observes several resources through one subscription", async () => {
    const test = comfyHost();
    const files = requireFiles(test.connect());
    const changes: OqtoFileChange[] = [];

    await files.watchResources([test.ref("jobs"), test.ref("outputs")], (change) => changes.push(change));

    test.externalWrite("jobs", '{"job":1}');
    test.externalWrite("first.png", "aa");
    test.flushFileChanges();
    await settle();

    // A collection ref expands to its members, so one subscription covers both.
    expect(changes.map((change) => change.ref).sort()).toEqual(
      [test.ref("first.png"), test.ref("jobs")].sort(),
    );
    expect(changes.every((change) => typeof change.generation === "number")).toBe(true);
  });

  it("flags a gap when the host coalesced changes", async () => {
    const test = comfyHost();
    const files = requireFiles(test.connect());
    const changes: OqtoFileChange[] = [];
    await files.watch(test.ref("jobs"), (change) => changes.push(change));

    // Two writes with a single flush is exactly the coalescing case an App
    // must not mistake for having seen every intermediate version.
    test.externalWrite("jobs", "one");
    test.externalWrite("jobs", "two");
    test.flushFileChanges();
    await settle();

    expect(changes).toHaveLength(1);
    expect(changes[0]?.gap).toBe(true);
    expect(changes[0]?.version).toBe(test.versionOf("jobs"));
  });

  it("does not flag a gap for a contiguous stream", async () => {
    const test = comfyHost();
    const files = requireFiles(test.connect());
    const changes: OqtoFileChange[] = [];
    await files.watch(test.ref("jobs"), (change) => changes.push(change));

    test.externalWrite("jobs", "one");
    test.flushFileChanges();
    await settle();
    test.externalWrite("jobs", "two");
    test.flushFileChanges();
    await settle();

    expect(changes).toHaveLength(2);
    expect(changes.some((change) => change.gap === true)).toBe(false);
    expect(changes[1]?.generation).toBe((changes[0]?.generation ?? 0) + 1);
  });

  it("rejects an empty multi-resource watch", async () => {
    const files = requireFiles(comfyHost().connect());
    await expect(files.watchResources([], () => undefined)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("stops delivering after unsubscribe", async () => {
    const test = comfyHost();
    const files = requireFiles(test.connect());
    const changes: OqtoFileChange[] = [];
    const stop = await files.watchResources([test.ref("jobs")], (change) => changes.push(change));

    stop();
    test.externalWrite("jobs", "later");
    test.flushFileChanges();
    await settle();

    expect(changes).toEqual([]);
  });
});
