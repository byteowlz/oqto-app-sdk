import type { OqtoFileRef, OqtoFileVersion, OqtoFilesCapability } from "@byteowlz/oqto-app-sdk";

interface Scene {
  readonly type: "excalidraw";
  readonly version: number;
  readonly elements: readonly unknown[];
}

/** Minimal example; dgrmr maps conflict results to its own SceneError.stale. */
export class FilesSceneStore {
  private fileVersion: OqtoFileVersion | undefined;

  constructor(
    private readonly files: OqtoFilesCapability,
    private readonly ref: OqtoFileRef,
  ) {}

  async load(): Promise<Scene> {
    const contents = await this.files.read(this.ref);
    this.fileVersion = contents.version;
    return JSON.parse(new TextDecoder().decode(contents.bytes)) as Scene;
  }

  async save(scene: Scene): Promise<void> {
    if (!this.fileVersion) throw new Error("Load before save");
    const result = await this.files.write(
      this.ref,
      new TextEncoder().encode(`${JSON.stringify(scene, null, 2)}\n`),
      { expectedVersion: this.fileVersion },
    );
    if (!result.ok) {
      throw new Error(`Scene changed externally (current file version: ${result.currentVersion})`);
    }
    this.fileVersion = result.stat.version;
  }
}
