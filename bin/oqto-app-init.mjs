#!/usr/bin/env node

// oqto-app-init — scaffold a capability-bounded Oqto App package.
//
// Creates `<dir>/<slug>.oqtoapp/` with a manifest that the current Oqto
// runtime accepts (schema oqto-app/v0, sandboxed-web presentation, work-
// directory binding), a minimal but real presentation App, and a package.json
// whose SDK dependency resolves offline on managed hosts:
//
//   1. `--sdk <spec>` flag wins,
//   2. then $OQTO_APP_SDK_PATH (used verbatim, e.g. a file: directory),
//   3. then the newest version directory under $OQTO_APP_SDK_HOME,
//   4. then $HOME/.local/share/oqto/app-sdk (the store oqto-usermgr
//      provisions from the oqto-templates pool — no env var required),
//   5. finally a github fallback pinned to this SDK's own version.
//
// No network is required when 2 or 3 apply. This script must stay dependency-
// free so it can run from a provisioned store on locked-down hosts.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
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

function ownVersion() {
  const packageJson = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    return JSON.parse(readFileSync(packageJson, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
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

async function resolveSdkSpec(explicit) {
  if (explicit) {
    return explicit;
  }
  const directPath = process.env.OQTO_APP_SDK_PATH;
  if (directPath) {
    return `file:${directPath}`;
  }
  // Managed hosts provision the store here; oqto-usermgr writes the env var
  // only into fresh dotfiles, so existing users rely on the default path.
  const fromEnv = await newestStoreVersion(process.env.OQTO_APP_SDK_HOME);
  if (fromEnv) {
    return `file:${fromEnv}`;
  }
  const home = process.env.HOME;
  if (home) {
    const fromHome = await newestStoreVersion(path.join(home, ".local/share/oqto/app-sdk"));
    if (fromHome) {
      return `file:${fromHome}`;
    }
  }
  return `github:byteowlz/oqto-app-sdk#v${ownVersion()}`;
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
				font-family: system-ui, sans-serif;
				display: grid;
				place-items: center;
				min-height: 100vh;
				margin: 0;
			}
			main {
				text-align: center;
				display: grid;
				gap: 0.75rem;
				padding: 1rem;
			}
			#counter {
				font: inherit;
				padding: 0.6rem 1.2rem;
				cursor: pointer;
			}
			#status {
				opacity: 0.6;
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

An Oqto App scaffolded with \`oqto-app-init\`.

## Build

\`\`\`bash
bun install
bun run build
\`\`\`

On managed hosts the SDK dependency resolves from the provisioned offline
store (\`$OQTO_APP_SDK_HOME\`) and needs no network.

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
  const sdkSpec = await resolveSdkSpec(options.sdk);

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
