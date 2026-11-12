#!/usr/bin/env node
/**
 * Temporarily run operon against a local, unreleased operon-agents checkout.
 *
 *   node scripts/dev-operon-agents.mjs link      # build local packages, overlay them into node_modules
 *   node scripts/dev-operon-agents.mjs link --no-build
 *   node scripts/dev-operon-agents.mjs link --peers   # also install a Teams extension bundle built from it
 *   node scripts/dev-operon-agents.mjs status
 *   node scripts/dev-operon-agents.mjs restore   # put the npm-published versions back
 *
 * Source checkout: $OPERON_AGENTS_DIR, default ../operon-agents.
 *
 * Why overlay instead of `npm link` / symlinks:
 * - a symlinked package resolves its own deps from the other repo's pnpm tree, so zod / pi-ai / MCP SDK
 *   end up as two instances and `instanceof` / schema identity checks break;
 * - scripts/build-peers-extension.mjs decides what to bundle by matching `node_modules/operon-agents…`
 *   in the resolved path, which a symlink's realpath no longer contains.
 * Copying `dist` + `package.json` keeps everything resolving from this repo's node_modules. That only
 * works while the local packages' runtime dependencies match the installed ones, which `link` checks.
 *
 * package.json / package-lock.json are never touched; the originals are backed up under
 * node_modules/.operon-agents-dev-backup and `restore` moves them back (as does a plain `npm ci`).
 *
 * `--peers`: the Teams extension is not loaded from node_modules but from the installed bundle
 * under <OPERON_DATA_DIR>/extensions/peers (downloaded from the extension market), which carries
 * its own copy of operon-agents-peers. To exercise Teams against the local framework, `--peers`
 * rebuilds that bundle from this repo + the overlaid packages and installs it there, keeping the
 * installed one for `restore`. The market only replaces it when it offers a newer version.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { buildPeersExtension } from "./build-peers-extension.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = path.join(root, "node_modules");
const backupDir = path.join(nodeModules, ".operon-agents-dev-backup");
const markerFile = path.join(backupDir, "linked.json");
const sourceRoot = path.resolve(root, process.env.OPERON_AGENTS_DIR ?? "../operon-agents");
// Same resolution as server/src/services/operon-runtime/paths.ts.
const operonDataDir = process.env.OPERON_DATA_DIR
  || path.join(path.resolve(process.env.OPERON_HOME || path.join(os.homedir(), ".operon")), "data");
const peersExtensionDir = path.join(operonDataDir, "extensions", "peers");
const peersBackup = path.join(backupDir, "peers-extension");

/** npm package name -> directory under <operon-agents>/packages */
const PACKAGES = {
  "operon-agents-core": "agents-core",
  "operon-agents": "agents",
  "operon-agents-peers": "agents-peers",
  "operon-code-mode": "code-mode",
};

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const installedDir = (name) => path.join(nodeModules, name);
const sourceDir = (name) => path.join(sourceRoot, "packages", PACKAGES[name]);

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}`);
}

function gitRev(cwd) {
  const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).stdout.trim();
  return res.status === 0 ? `${res.stdout.trim()}${dirty ? "+dirty" : ""}` : "unknown";
}

/** Runtime deps the local build needs that the installed copy does not provide. */
async function missingDeps(name) {
  const local = (await readJson(path.join(sourceDir(name), "package.json"))).dependencies ?? {};
  const missing = [];
  for (const dep of Object.keys(local)) {
    if (dep in PACKAGES) continue;
    const candidates = [
      path.join(installedDir(name), "node_modules", dep, "package.json"),
      path.join(nodeModules, dep, "package.json"),
    ];
    if (!candidates.some((file) => existsSync(file))) missing.push(`${dep}@${local[dep]}`);
  }
  return missing;
}

async function link({ build, peers }) {
  if (!existsSync(path.join(sourceRoot, "packages"))) {
    throw new Error(`operon-agents checkout not found at ${sourceRoot} (set OPERON_AGENTS_DIR)`);
  }
  if (build) {
    // One filter list so pnpm builds in dependency order (core -> agents -> peers / code-mode).
    run("pnpm", Object.keys(PACKAGES).flatMap((name) => ["--filter", name]).concat("build"), sourceRoot);
  }

  for (const name of Object.keys(PACKAGES)) {
    if (!existsSync(path.join(sourceDir(name), "dist"))) throw new Error(`${name}: no dist/, build it first`);
    if (!existsSync(installedDir(name))) throw new Error(`${name} is not installed; run npm install first`);
    const missing = await missingDeps(name);
    if (missing.length > 0) {
      throw new Error(
        `${name} (local) needs dependencies not installed here: ${missing.join(", ")}.\n` +
          "Install them (npm i --no-save …) or bump the version in package.json instead of overlaying.",
      );
    }
  }

  await mkdir(backupDir, { recursive: true });
  const alreadyLinked = existsSync(markerFile);
  for (const name of Object.keys(PACKAGES)) {
    const target = installedDir(name);
    const backup = path.join(backupDir, name);
    // Back up the npm copy once; relinking must not overwrite it with a previous overlay.
    if (!alreadyLinked && !existsSync(backup)) await cp(target, backup, { recursive: true });
    await rm(path.join(target, "dist"), { recursive: true, force: true });
    await cp(path.join(sourceDir(name), "dist"), path.join(target, "dist"), { recursive: true });
    await cp(path.join(sourceDir(name), "package.json"), path.join(target, "package.json"));
  }

  let previous = {};
  if (alreadyLinked) previous = await readJson(markerFile);
  if (peers) {
    if (existsSync(peersExtensionDir) && !existsSync(peersBackup)) await cp(peersExtensionDir, peersBackup, { recursive: true });
    const dest = await buildPeersExtension({ root, outdir: operonDataDir });
    console.log(`Installed a Teams extension bundle built against the local packages at ${dest}`);
  }

  const rev = gitRev(sourceRoot);
  await writeFile(markerFile, JSON.stringify({
    sourceRoot, rev, linkedAt: new Date().toISOString(), peers: peers || previous.peers === true,
  }, null, 2));
  console.log(`\nLinked local operon-agents (${rev}) from ${sourceRoot}`);
  console.log("Restart the dev server / Electron so the server process reloads them.");
  console.log("Undo with: node scripts/dev-operon-agents.mjs restore");
}

async function restore() {
  if (!existsSync(backupDir)) {
    console.log("Nothing to restore: node_modules already holds the npm versions.");
    return;
  }
  for (const name of Object.keys(PACKAGES)) {
    const backup = path.join(backupDir, name);
    if (!existsSync(backup)) continue;
    await rm(installedDir(name), { recursive: true, force: true });
    await rename(backup, installedDir(name));
  }
  const info = existsSync(markerFile) ? await readJson(markerFile) : {};
  if (existsSync(peersBackup)) {
    await rm(peersExtensionDir, { recursive: true, force: true });
    await cp(peersBackup, peersExtensionDir, { recursive: true });
    console.log(`Restored the installed Teams extension at ${peersExtensionDir}.`);
  } else if (info.peers) {
    // Nothing was installed before the local build: remove it so the market's copy is fetched again.
    await rm(peersExtensionDir, { recursive: true, force: true });
    console.log(`Removed the locally built Teams extension; reinstall it from Settings → Extensions.`);
  }
  await rm(backupDir, { recursive: true, force: true });
  console.log("Restored npm-published operon-agents packages.");
}

async function status() {
  if (existsSync(markerFile)) {
    const info = await readJson(markerFile);
    console.log(`LINKED to local ${info.sourceRoot} @ ${info.rev} (since ${info.linkedAt})${info.peers ? ", Teams extension rebuilt" : ""}`);
  } else {
    console.log("Using npm-published packages.");
  }
  for (const name of Object.keys(PACKAGES)) {
    const file = path.join(installedDir(name), "package.json");
    console.log(`  ${name}: ${existsSync(file) ? (await readJson(file)).version : "not installed"}`);
  }
}

const [command, ...flags] = process.argv.slice(2);
const commands = {
  link: () => link({ build: !flags.includes("--no-build"), peers: flags.includes("--peers") }),
  restore,
  status,
};
if (!commands[command]) {
  console.error("Usage: node scripts/dev-operon-agents.mjs <link [--no-build] [--peers] | restore | status>");
  process.exit(1);
}
commands[command]().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
