/**
 * Build the headless node as an installable npm tarball:
 *
 *   release/operon-node-<version>.tgz   →   npm install -g <that file or its URL>
 *
 * which gives the `operon` command (server/src/cli.ts): `operon serve`,
 * `operon service install`, `operon node join <code>`. It is what runs on a
 * Linux server with no desktop. Attached to each GitHub release by CI.
 *
 * Layout of the package — deliberately the same as the desktop app's resources,
 * so the server finds everything the way it does when packaged in Electron:
 *
 *   dist/cli.js              server + CLI, one esbuild bundle
 *   dist/storage/migrations  the SQL migrations (index.ts looks next to itself)
 *   operon-runtime/          `npm run build:operon-runtime`'s output: node-repl
 *                            kernel, browser/computer clients, skills, connectors
 *
 * The bundle sets `process.resourcesPath` to the package root before anything
 * else runs. Every place that finds a packaged runtime file already reads
 * `<resourcesPath>/operon-runtime/…` (node-repl-mcp.ts, the *-skill.ts files,
 * connectors/registry.ts, browser-use/peer-auth.ts), so none needs a second
 * code path.
 *
 * Left out, because they are macOS-only or opt-in: the cua-driver binary and the
 * peer-auth addon (Computer Use and the codesign check are macOS features),
 * node-llama-cpp and sqlite-vec (memory, off on a headless node).
 *
 * Packages with native addons, vendored binaries or files they find through
 * their own path stay external and become the tarball's dependencies, pinned to
 * the versions installed here. It is the same list the Electron main build keeps
 * external (vite.config.ts), plus playwright-core.
 *
 *   node scripts/build-node-package.mjs [--skip-runtime]
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(root, "build", "node-package");
const releaseDir = path.join(root, "release");
const require_ = createRequire(path.join(root, "package.json"));
const rootPkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = rootPkg.version;

const EXTERNAL = [
  "better-sqlite3",
  "@lydell/node-pty",
  "@anthropic-ai/claude-agent-sdk",
  "@qoder-ai/qoder-agent-sdk",
  "@grpc/grpc-js",
  "tree-sitter-bash",
  "web-tree-sitter",
  "ws",
  "operon-agents",
  "operon-agents-core",
  "operon-agents-peers",
  "operon-code-mode",
  "playwright-core",
];
/** Imported somewhere behind a feature that is off here; left unresolved on purpose. */
const ABSENT = ["node-llama-cpp", "sqlite-vec", "keytar", "sharp", "bufferutil", "utf-8-validate", "electron"];
/** Runtime files that only work on macOS. */
const MAC_ONLY = new Set(["cua-driver", "cua-driver.stamp", ".cua-driver.json", "operon-peer-auth.node"]);

/** Read from disk: some packages do not export ./package.json, so require() cannot reach it. */
function installedVersion(name) {
  for (const dir of require_.resolve.paths(name) ?? []) {
    const file = path.join(dir, name, "package.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).version;
  }
  throw new Error(`cannot find the installed version of ${name}`);
}

// An external's package.json is inlined, as the Electron build does: ESM cannot
// import JSON without an attribute the source does not carry.
const isExternal = (id) =>
  !id.endsWith("/package.json") && [...EXTERNAL, ...ABSENT].some((m) => id === m || id.startsWith(`${m}/`));

if (!process.argv.includes("--skip-runtime")) {
  execFileSync(process.execPath, [path.join(root, "scripts", "build-operon-runtime.mjs")], { stdio: "inherit", cwd: root });
}
const runtimeDir = path.join(root, "dist-operon-runtime");
if (!existsSync(path.join(runtimeDir, "node-repl-kernel.js"))) {
  throw new Error("dist-operon-runtime is missing; run `npm run build:operon-runtime` first");
}

await rm(outRoot, { recursive: true, force: true });
await mkdir(path.join(outRoot, "dist"), { recursive: true });

// The banner runs before any bundled module. CommonJS dependencies need
// `require` in an ESM file; __dirname is not shimmed, because bundled ESM
// modules (index.ts) declare their own at top level and would collide.
// resourcesPath must be set before node-repl-mcp.ts and the skills read it.
const banner = `#!/usr/bin/env node
import { createRequire as __operonCreateRequire } from 'node:module';
import { fileURLToPath as __operonFileURLToPath } from 'node:url';
import __operonPath from 'node:path';
const require = __operonCreateRequire(import.meta.url);
if (!process.resourcesPath) process.resourcesPath = __operonPath.resolve(__operonPath.dirname(__operonFileURLToPath(import.meta.url)), '..');`;

const result = await build({
  absWorkingDir: root,
  entryPoints: { cli: "server/src/cli.ts" },
  outdir: path.join(outRoot, "dist"),
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: false,
  metafile: true,
  banner: { js: banner },
  alias: { "@shared": path.join(root, "shared") },
  define: {
    __ENABLE_MEMORY__: "false",
    __OPERON_VERSION__: JSON.stringify(version),
  },
  loader: { ".node": "empty" },
  plugins: [{
    name: "operon-externals",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => (isExternal(args.path) ? { path: args.path, external: true } : undefined));
    },
  }],
  logLevel: "warning",
});

// Pin every external that the bundle actually imports to the installed version.
const imported = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imp of output.imports) {
    if (!imp.external || imp.path.startsWith("node:")) continue;
    const name = imp.path.startsWith("@") ? imp.path.split("/").slice(0, 2).join("/") : imp.path.split("/")[0];
    if (EXTERNAL.includes(name)) imported.add(name);
  }
}
const dependencies = {};
for (const name of [...imported].sort()) {
  dependencies[name] = installedVersion(name);
}

const migrations = path.join(root, "server", "src", "storage", "migrations");
await cp(migrations, path.join(outRoot, "dist", "storage", "migrations"), { recursive: true });
await cp(migrations, path.join(outRoot, "dist", "migrations"), { recursive: true });
await cp(runtimeDir, path.join(outRoot, "operon-runtime"), {
  recursive: true,
  filter: (src) => !MAC_ONLY.has(path.basename(src)),
});

await writeFile(path.join(outRoot, "package.json"), `${JSON.stringify({
  name: "operon-node",
  version,
  description: "operon headless node: run operon on a server and use it from your other machines",
  license: rootPkg.license,
  type: "module",
  bin: { operon: "dist/cli.js" },
  engines: { node: ">=22" },
  os: ["linux", "darwin"],
  dependencies,
}, null, 2)}\n`);
await writeFile(path.join(outRoot, "README.md"), `# operon node ${version}

Run operon on a server (no desktop needed) and use it from your other machines.

\`\`\`bash
npm install -g operon-node-${version}.tgz
operon service install        # systemd user service, starts at boot
operon node join <code>       # code: on a signed-in machine, Settings → Remote → Add a server
operon project add [path]     # register an existing Git checkout (defaults to the current directory)
operon device pair            # paste the code in Operon on the web or mobile, then approve here
\`\`\`

\`operon --help\` lists every command.
`);

await mkdir(releaseDir, { recursive: true });
const packed = execFileSync("npm", ["pack", "--pack-destination", releaseDir, "--json"], { cwd: outRoot, encoding: "utf8" });
const file = JSON.parse(packed)[0]?.filename;
console.log(`\nBuilt ${path.join(releaseDir, file)}`);
console.log(`Dependencies: ${Object.keys(dependencies).join(", ")}`);
console.log(`Runtime files: ${readdirSync(path.join(outRoot, "operon-runtime")).join(", ")}`);
