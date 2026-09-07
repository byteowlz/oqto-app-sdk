import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "oqto-app-init.mjs");

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = path.join(os.tmpdir(), `oqto-app-init-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

type RunOptions = {
  sdkHome?: string;
  sdkPath?: string;
};

function run(args: string[], options: RunOptions = {}): string {
  const env: Record<string, string | undefined> = { ...process.env };
  // Keep resolution deterministic regardless of the developer's shell env.
  delete env.OQTO_APP_SDK_HOME;
  delete env.OQTO_APP_SDK_PATH;
  if (options.sdkHome !== undefined) {
    env.OQTO_APP_SDK_HOME = options.sdkHome;
  }
  if (options.sdkPath !== undefined) {
    env.OQTO_APP_SDK_PATH = options.sdkPath;
  }
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: env as NodeJS.ProcessEnv,
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("oqto-app-init", () => {
  it("scaffolds a publishable presentation package", () => {
    const root = makeTempRoot();
    run(["My Tool", "--dir", root, "--sdk", "file:/sdk/store/0.3.1"]);

    const target = path.join(root, "my-tool.oqtoapp");
    expect(existsSync(path.join(target, "oqto-app.toml"))).toBe(true);
    expect(existsSync(path.join(target, "src", "app.ts"))).toBe(true);
    expect(existsSync(path.join(target, "bundle", "index.html"))).toBe(true);

    const manifest = readFileSync(path.join(target, "oqto-app.toml"), "utf8");
    expect(manifest).toContain('schema = "oqto-app/v0"');
    expect(manifest).toContain('id = "my-tool"');
    expect(manifest).toContain('presentations = ["sandboxed-web"]');
    expect(manifest).toContain('entry = "bundle/index.html"');

    const packageJson = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"));
    expect(packageJson.dependencies["@byteowlz/oqto-app-sdk"]).toBe("file:/sdk/store/0.3.1");
    expect(packageJson.scripts.build).toContain("bundle/assets/app.js");
  });

  it("resolves the offline SDK store from OQTO_APP_SDK_HOME", () => {
    const root = makeTempRoot();
    const store = path.join(root, "app-sdk-store");
    mkdirSync(path.join(store, "0.3.0"), { recursive: true });
    mkdirSync(path.join(store, "0.3.1"), { recursive: true });

    run(["alpha", "--dir", root], { sdkHome: store });

    const packageJson = JSON.parse(readFileSync(path.join(root, "alpha.oqtoapp", "package.json"), "utf8"));
    expect(packageJson.dependencies["@byteowlz/oqto-app-sdk"]).toBe(`file:${path.join(store, "0.3.1")}`);
  });

  it("prefers OQTO_APP_SDK_PATH verbatim when set", () => {
    const root = makeTempRoot();
    run(["direct", "--dir", root], { sdkPath: "/opt/sdk/current" });

    const packageJson = JSON.parse(readFileSync(path.join(root, "direct.oqtoapp", "package.json"), "utf8"));
    expect(packageJson.dependencies["@byteowlz/oqto-app-sdk"]).toBe("file:/opt/sdk/current");
  });

  it("falls back to a version-pinned github spec and refuses collisions", () => {
    const root = makeTempRoot();
    run(["beta", "--dir", root]);
    const packageJson = JSON.parse(readFileSync(path.join(root, "beta.oqtoapp", "package.json"), "utf8"));
    expect(packageJson.dependencies["@byteowlz/oqto-app-sdk"]).toBe("github:byteowlz/oqto-app-sdk#v0.3.1");

    expect(() => run(["beta", "--dir", root])).toThrow();
    expect(() => run(["beta", "--dir", root, "--force"])).not.toThrow();
  });

  it("slugifies names and ships the bin executable", () => {
    const root = makeTempRoot();
    run(["My Fancy Tool!", "--dir", root]);
    expect(existsSync(path.join(root, "my-fancy-tool.oqtoapp"))).toBe(true);
    const mode = statSync(BIN).mode & 0o777;
    expect(mode & 0o111).toBe(0o111);
  });
});
