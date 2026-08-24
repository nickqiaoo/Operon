#!/usr/bin/env node
/**
 * Builds the Chrome Web Store upload zip for `packages/chrome-extension`.
 *
 * The store listing id (`annipikgonognboogflchfnagmhbbipc`) is assigned by the dashboard, so
 * the uploaded manifest must NOT carry the `key` field that pins the unpacked dev id — Chrome
 * rejects a package whose key does not match the listing. Everything else ships verbatim;
 * `background.js` is plain JS and needs no build step.
 *
 * Usage: node scripts/pack-chrome-extension.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(repoRoot, "packages/chrome-extension");
// `release/` (gitignored) holds shippable artifacts alongside the electron-builder output.
// NOT `dist/` — the web build owns that directory and empties it on every run, which silently
// deletes any extension zip left there.
const outDir = path.join(repoRoot, "release");

/** Runtime files only — tests, tsconfig and internal docs stay out of the upload. */
const INCLUDE = [
  "manifest.json",
  "background.js",
  "content-cursor.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "icons",
  "images",
  "LICENSE",
  "NOTICE.md",
];

const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, "manifest.json"), "utf8"));
const { version } = manifest;
delete manifest.key;

const stageDir = path.join(outDir, `stage-${version}`);
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

for (const entry of INCLUDE) {
  const from = path.join(srcDir, entry);
  if (!fs.existsSync(from)) throw new Error(`missing extension file: ${entry}`);
  if (entry === "manifest.json") continue;
  fs.cpSync(from, path.join(stageDir, entry), { recursive: true });
}
fs.writeFileSync(path.join(stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const zipPath = path.join(outDir, `operon-browser-use-${version}.zip`);
fs.rmSync(zipPath, { force: true });
execFileSync("zip", ["-r", "-X", "-q", zipPath, "."], { cwd: stageDir });
fs.rmSync(stageDir, { recursive: true, force: true });

const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`operon browser use extension v${version} -> ${path.relative(repoRoot, zipPath)} (${size} KB)`);
