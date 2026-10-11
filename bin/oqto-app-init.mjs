#!/usr/bin/env node

// oqto-app-init — scaffold a capability-bounded Oqto App package.
//
// Creates `<dir>/<slug>.oqtoapp/` with a manifest that the current Oqto
// runtime accepts (schema oqto-app/v0, sandboxed-web presentation, work-
// directory binding), a minimal but real presentation App, and a portable
// SDK dependency that resolves offline and has no absolute path:
//
//   When a local SDK package is resolvable (in order: `--sdk file:...`,
//   $OQTO_APP_SDK_PATH, newest under $OQTO_APP_SDK_HOME, then
//   $HOME/.local/share/oqto/app-sdk — the store oqto-usermgr provisions from
//   the templates pool), this scaffold VENDORS it into `<app>/_sdk/` and
//   depends on "file:./_sdk". The App is then fully self-contained and builds
//   on any machine or container with no network.
//
//   Only when no local SDK exists does it fall back to a github dependency
//   pinned to this SDK's own version.
//
// No network is required whenever a local SDK is present. This script must
// stay dependency-free so it can run from a provisioned store on locked-down
// hosts.

import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const USAGE = `oqto-app-init — scaffold an Oqto App package

USAGE
    oqto-app-init <name> [options]

OPTIONS
    --dir <path>     Parent directory for the package (default: ./oqto-apps)
    --sdk <spec>     Dependency spec for @byteowlz/oqto-app-sdk
                     (default: $OQTO_APP_SDK_PATH, then $OQTO_APP_SDK_HOME,
                     then $HOME/.local/share/oqto/app-sdk/<newest>,
                     then github:byteowlz/oqto-app-sdk#v<version>)

    When a local SDK is resolvable it is vendored into <app>/_sdk/ and the
    package depends on "file:./_sdk", so each App is self-contained and
    portable (no absolute or machine-specific paths).
    --force          Replace an existing package directory
    -h, --help       Show this help

EXAMPLES
    oqto-app-init my-tool
    oqto-app-init my-tool --dir ~/byteowlz/my-lab
    oqto-app-init my-tool --sdk "file:$OQTO_APP_SDK_PATH"
`;

function fail(message) {
  process.stderr.write(`oqto-app-init: ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function slugify(raw) {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) {
    fail(`"${raw}" is not a usable App id (expected 2-64 chars: a-z, 0-9, dashes)`);
  }
  return slug;
}

function tomlString(raw) {
  return raw
    .replace(/[\\\n\r]/g, " ")
    .replace(/"/g, "'")
    .trim();
}

function packageVersion(packageRoot) {
  try {
    const packageJson = path.join(packageRoot, "package.json");
    return JSON.parse(readFileSync(packageJson, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function ownVersion() {
  return packageVersion(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
}

function compareVersions(a, b) {
  const parts = (value) => value.split(".").map((piece) => Number.parseInt(piece, 10) || 0);
  const [aMajor, aMinor, aPatch] = parts(a);
  const [bMajor, bMinor, bPatch] = parts(b);
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch || a.localeCompare(b);
}

async function newestStoreVersion(home) {
  if (!home || !existsSync(home)) {
    return undefined;
  }
  const versions = (await readdir(home)).filter((entry) => /^\d+\.\d+\.\d+$/.test(entry));
  const newest = versions.sort(compareVersions).at(-1);
  return newest ? path.join(home, newest) : undefined;
}

function isFileSpec(spec) {
  return typeof spec === "string" && /^file:/i.test(spec);
}

function stripFileSpec(spec) {
  return spec.replace(/^file:/i, "");
}

// Resolve the SDK dependency. Returns { spec, localPath }: `spec` is the
// package.json dependency value; `localPath` is the SDK package directory when
// a local copy is available (so the scaffold can vendor it for portability).
async function resolveSdk(explicit) {
  let spec;
  let localPath;
  if (explicit) {
    spec = explicit;
    if (isFileSpec(spec)) {
      localPath = stripFileSpec(spec);
    }
  } else {
    const directPath = process.env.OQTO_APP_SDK_PATH;
    if (directPath) {
      localPath = directPath;
      spec = `file:${directPath}`;
    } else {
      // Managed hosts provision the store here; oqto-usermgr writes the env
      // var only into fresh dotfiles, so existing users rely on the default
      // path.
      const fromEnv = await newestStoreVersion(process.env.OQTO_APP_SDK_HOME);
      if (fromEnv) {
        localPath = fromEnv;
        spec = `file:${fromEnv}`;
      } else {
        const home = process.env.HOME;
        if (home) {
          const fromHome = await newestStoreVersion(path.join(home, ".local/share/oqto/app-sdk"));
          if (fromHome) {
            localPath = fromHome;
            spec = `file:${fromHome}`;
          }
        }
      }
    }
  }
  if (!spec) {
    spec = `github:byteowlz/oqto-app-sdk#v${ownVersion()}`;
  }
  return { spec, localPath };
}

// Copy a resolvable SDK package's `dist/` into `<target>/_sdk/` and write a
// minimal package.json so `file:./_sdk` resolves the same subpaths (".",
// "./testing", "./host") offline and on any machine. Returns the vendor
// manifest, or undefined when the resolvable path has no dist/ (the caller
// then falls back to a non-vendored spec).
async function vendorSdk(packageRoot, target) {
  const distRoot = path.join(packageRoot, "dist");
  if (!existsSync(distRoot)) {
    return undefined;
  }
  const version = packageVersion(packageRoot);
  const vendorRoot = path.join(target, "_sdk");
  await mkdir(path.join(vendorRoot, "dist"), { recursive: true });
  const entries = await readdir(distRoot, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(distRoot, entry.name);
    const destination = path.join(vendorRoot, "dist", entry.name);
    if (entry.isDirectory()) {
      await cp(source, destination, { recursive: true });
    } else if (entry.isFile() && !/\.map$/.test(entry.name)) {
      // Copy runtime + types; skip source maps for a lean portable vendor.
      await cp(source, destination);
    }
  }
  const manifest = {
    name: "@byteowlz/oqto-app-sdk",
    version,
    private: true,
    type: "module",
    sideEffects: false,
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
      "./host": { types: "./dist/host.d.ts", import: "./dist/host.js", default: "./dist/host.js" },
      "./testing": {
        types: "./dist/testing.d.ts",
        import: "./dist/testing.js",
        default: "./dist/testing.js",
      },
      "./package.json": "./package.json",
    },
  };
  await writeFile(path.join(vendorRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseArgs(argv) {
  const options = { name: undefined, dir: "oqto-apps", sdk: undefined, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === "--dir") {
      const value = argv[index + 1];
      if (!value) fail("--dir requires a path");
      options.dir = value;
      index += 1;
    } else if (arg === "--sdk") {
      const value = argv[index + 1];
      if (!value) fail("--sdk requires a dependency spec");
      options.sdk = value;
      index += 1;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg.startsWith("-")) {
      fail(`unknown option: ${arg}`);
    } else if (options.name === undefined) {
      options.name = arg;
    } else {
      fail(`unexpected argument: ${arg}`);
    }
  }
  if (!options.name) {
    process.stdout.write(USAGE);
    process.exit(1);
  }
  return options;
}

function manifestTemplate(slug, title) {
  return `# Oqto App manifest. Requests are NOT grants: publication pins this
# request and the operation implementation into an immutable Definition and
# the App stays inert until the user approves it. Editing anything in this
# package (including this file) changes the content digest and requires
# republish + re-approval.
schema = "oqto-app/v0"
id = "${slug}"
version = "0.1.0"
title = { en = "${tomlString(title)}", de = "${tomlString(title)}" }
description = "TODO: one sentence on what this App does."
presentations = ["sandboxed-web"]
requested_capabilities = ["kv"]
bindings = ["work-directory"]
default_binding = "work-directory"

[presentation.sandboxed-web]
entry = "bundle/index.html"

# Authority tables: "files", "operations" and "agent_context" each REQUIRE a
# [capability.<name>] table; "theme" and "kv" take none. To read/write bound
# work-directory files, add "files" to requested_capabilities and uncomment:
#
# [capability.files]
# [[capability.files.resources]]   # 1..32 resources
# role = "data"                    # semantic name the App addresses
# path = "data.json"               # work-directory-relative; no .git/.oqto/oqto-apps
# access = "read"                  # "read" | "readwrite"
# watch = true                     # optional, default false

[instance_state]
versioned = false

[assets]
max_bytes = 100000
`;
}

function packageJsonTemplate(slug, sdkSpec) {
  return `${JSON.stringify(
    {
      name: `${slug}-oqto-app`,
      private: true,
      type: "module",
      scripts: {
        build: "bun build src/app.ts --outfile bundle/assets/app.js --minify",
      },
      dependencies: {
        "@byteowlz/oqto-app-sdk": sdkSpec,
      },
    },
    null,
    "\t",
  )}\n`;
}

function appTsTemplate() {
  return `import { applyOqtoTheme, connectOqtoApp } from "@byteowlz/oqto-app-sdk";

const status = document.querySelector<HTMLSpanElement>("#status");
const counter = document.querySelector<HTMLButtonElement>("#counter");

function setStatus(message: string): void {
	if (status) {
		status.textContent = message;
	}
}

async function main(): Promise<void> {
	const app = await connectOqtoApp();
	setStatus(\`connected · \${app.context.instanceId.slice(0, 12)}…\`);

	// Theme is a baseline capability: mirror the host look without hardcoding
	// colors. applyOqtoTheme only touches --custom properties the host sent.
	if (app.theme) {
		const root = document.documentElement;
		applyOqtoTheme(root, await app.theme.get());
		app.theme.watch((theme) => applyOqtoTheme(root, theme));
	}

	// KV is private preference storage for this App Instance.
	let clicks = 0;
	if (app.kv) {
		const stored = await app.kv.get("clicks");
		clicks = typeof stored === "number" ? stored : 0;
	}

	const button = counter;
	if (button) {
		const render = () => {
			button.textContent = \`clicked \${clicks}×\`;
		};
		render();
		button.addEventListener("click", () => {
			clicks += 1;
			render();
			void app.kv?.set("clicks", clicks);
		});
	}
}

main().catch((error: unknown) => {
	setStatus(error instanceof Error ? error.message : "connection failed");
});
`;
}

function indexHtmlTemplate(title) {
  return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${tomlString(title)}</title>
		<style>
			:root {
				color-scheme: light dark;
			}
			body {
				font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
				background: var(--background);
				color: var(--foreground);
				display: grid;
				place-items: center;
				min-height: 100vh;
				margin: 0;
			}
			main {
				display: grid;
				gap: 0.75rem;
				padding: 2rem;
				min-width: min(24rem, calc(100vw - 2rem));
				background: var(--card);
				color: var(--card-foreground);
				border: 1px solid var(--border);
				border-radius: var(--radius-lg, 0.75rem);
				box-shadow: var(--shadow-md, 0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px rgb(0 0 0 / 0.08));
			}
			h1 {
				margin: 0;
				font-size: 1.25rem;
				font-weight: 650;
				letter-spacing: -0.01em;
			}
			#counter {
				font: inherit;
				font-weight: 550;
				padding: 0.6rem 1.2rem;
				cursor: pointer;
				color: var(--primary-foreground);
				background: var(--primary);
				border: 1px solid transparent;
				border-radius: var(--radius-md, 0.5rem);
				transition: filter 0.15s ease;
			}
			#counter:hover {
				filter: brightness(1.08);
			}
			#counter:focus-visible {
				outline: 3px solid color-mix(in srgb, var(--ring) 55%, transparent);
				outline-offset: 2px;
			}
			#status {
				color: var(--muted-foreground);
				font-size: 0.8rem;
			}
		</style>
	</head>
	<body>
		<main>
			<h1>${tomlString(title)}</h1>
			<button id="counter" type="button">clicked 0×</button>
			<span id="status" role="status">connecting…</span>
		</main>
		<script src="assets/app.js"></script>
	</body>
</html>
`;
}

function readmeTemplate(slug) {
  return `# ${slug}

An Oqto App scaffolded with \`oqto-app-init\`. The SDK is vendored into
\`_sdk/\` (a self-contained, portable copy of \`@byteowlz/oqto-app-sdk\`), so
builds need no network and no machine-specific path.

## Build

\`\`\`bash
bun install
bun run build
\`\`\`

\`bun install\` resolves \`@byteowlz/oqto-app-sdk\` from \`file:./_sdk\` (offline).
To bump the SDK, re-run \`oqto-app-init --force\` or replace \`_sdk/dist\` and the
\`_sdk/package.json\` in place, then \`bun install && bun run build\`.

## Open in Oqto

1. Put this package under \`<work-directory>/oqto-apps/${slug}.oqtoapp/\`.
2. Open it from Files (or the App catalog). Publication pins an immutable
   Definition; the first open asks you to review and grant access.
3. Edit \`oqto-app.toml\` to change requested capabilities. Any package change
   requires republish, and the user approves again only when the code changed.

See the \`oqto-apps\` skill for the full contract (manifest, capabilities,
operations, and the host-side lifecycle).
`;
}

const GITIGNORE = "node_modules/\n";

async function assertFreshTarget(target, force) {
  if (!existsSync(target)) {
    return;
  }
  const entries = await readdir(target);
  if (entries.length > 0) {
    if (!force) {
      fail(`${target} already exists and is not empty (use --force to replace it)`);
    }
    rmSync(target, { recursive: true, force: true });
  }
}

async function writeFileStrict(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { flag: "wx" });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const slug = slugify(options.name);
  const title = options.name.trim();
  const target = path.resolve(options.dir, `${slug}.oqtoapp`);
  await assertFreshTarget(target, options.force);
  const { spec, localPath } = await resolveSdk(options.sdk);
  let sdkSpec = spec;
  // Portable, offline SDK: vendor the resolvable dist/ into _sdk/ and depend
  // on it relatively so the App builds on any machine/container with no
  // network and no absolute path.
  const vendored = localPath ? await vendorSdk(localPath, target) : undefined;
  if (vendored) {
    sdkSpec = "file:./_sdk";
  }

  const files = new Map([
    ["oqto-app.toml", manifestTemplate(slug, title)],
    ["package.json", packageJsonTemplate(slug, sdkSpec)],
    ["src/app.ts", appTsTemplate()],
    ["bundle/index.html", indexHtmlTemplate(title)],
    ["README.md", readmeTemplate(slug)],
    [".gitignore", GITIGNORE],
  ]);
  await mkdir(target, { recursive: true });
  for (const [relative, content] of files) {
    await writeFileStrict(path.join(target, relative), content);
  }

  process.stdout.write(
    [
      `created ${target}`,
      `sdk dependency: ${sdkSpec}`,
      vendored
        ? "sdk: vendored into ./_sdk (portable, offline)"
        : "sdk: resolved via spec (no local dist/ to vendor)",
      "next:",
      "  1. bun install && bun run build",
      "  2. place the package in <work-directory>/oqto-apps/ (if not already there)",
      "  3. open it in Oqto and review the access request",
    ].join("\n"),
    "\n",
  );

  // Final existence sanity check so callers can trust the summary.
  await stat(path.join(target, "oqto-app.toml"));
}

try {
  await main();
} catch {
  // fail() already set a non-zero exit code and printed the reason.
}
