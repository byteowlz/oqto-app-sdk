import { describe, expect, it, vi } from "vitest";
import type {
  OqtoAppError,
  OqtoFileRef,
  OqtoFilesCapability,
  OqtoFileVersion,
  OqtoHost,
} from "../src/index.js";
import { createTestHost } from "../src/testing.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

function requireBoundFiles(host: OqtoHost): { files: OqtoFilesCapability; ref: OqtoFileRef } {
  if (!host.files || !host.context.bound) throw new Error("Test requires bound files");
  return { files: host.files, ref: host.context.bound.ref };
}

describe("files capability", () => {
  it("reads a bound resource and writes with an atomic version precondition", async () => {
    const test = createTestHost({
      files: [{ id: "scene", label: "diagram.excalidraw", mediaType: "application/json", bytes: "one" }],
      boundFileId: "scene",
    });
    const { files, ref } = requireBoundFiles(test.connect());

    const first = await files.read(ref);
    expect(decode(first.bytes)).toBe("one");
    expect(first.version).toBe("test-v1");

    const input = encode("two");
    const result = await files.write(ref, input, { expectedVersion: first.version });
    expect(result).toMatchObject({ ok: true, stat: { version: "test-v2", size: 3 } });
    expect(input.byteLength).toBe(3); // Bridge must not detach caller-owned bytes.
    expect(decode(test.contentsOf("scene"))).toBe("two");
  });

  it("refuses a stale write after a backend-agent edit without clobbering it", async () => {
    const test = createTestHost({
      files: [{ id: "scene", bytes: '{"writer":"initial"}' }],
      boundFileId: "scene",
    });
    const { files, ref } = requireBoundFiles(test.connect());
    const loaded = await files.read(ref);

    const agentVersion = test.externalWrite("scene", '{"writer":"agent"}');
    const result = await files.write(ref, encode('{"writer":"iframe"}'), {
      expectedVersion: loaded.version,
    });

    expect(result).toEqual({ ok: false, reason: "conflict", currentVersion: agentVersion });
    expect(decode(test.contentsOf("scene"))).toBe('{"writer":"agent"}');
  });

  it("supports stat polling without returning bytes", async () => {
    const test = createTestHost({ files: [{ id: "scene", bytes: "abc" }], boundFileId: "scene" });
    const { files, ref } = requireBoundFiles(test.connect());
    const stat = await files.stat(ref);

    expect(stat).toMatchObject({ version: "test-v1", size: 3 });
    expect(stat).not.toHaveProperty("bytes");
  });

  it("coalesces watcher changes to the newest version and unsubscribes", async () => {
    const test = createTestHost({ files: [{ id: "scene", bytes: "a" }], boundFileId: "scene" });
    const { files, ref } = requireBoundFiles(test.connect());
    const seen: OqtoFileVersion[] = [];
    const unsubscribe = await files.watch(ref, (change) => seen.push(change.version));

    test.externalWrite("scene", "b");
    test.externalWrite("scene", "c");
    test.flushFileChanges();
    await vi.waitFor(() => expect(seen).toEqual(["test-v3"]));

    unsubscribe();
    test.externalWrite("scene", "d");
    test.flushFileChanges();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual(["test-v3"]);
  });

  it("enforces read-only bindings", async () => {
    const test = createTestHost({
      files: [{ id: "scene", bytes: "a", access: "read" }],
      boundFileId: "scene",
    });
    const { files, ref } = requireBoundFiles(test.connect());
    const loaded = await files.read(ref);

    await expect(files.write(loaded.ref, encode("b"), { expectedVersion: loaded.version })).rejects.toEqual(
      expect.objectContaining<Partial<OqtoAppError>>({ code: "denied" }),
    );
  });
});
