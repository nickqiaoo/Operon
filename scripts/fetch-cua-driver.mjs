/**
 * Fetch the `cua-driver` daemon into `dist-operon-runtime/`.
 *
 * cua-driver is the alternative Computer Use engine (trycua/cua, MIT). Unlike
 * the Swift engine it is not built from this repo — upstream publishes signed
 * release binaries — so this downloads one rather than compiling ~13 Rust
 * crates on every machine.
 *
 * The universal build is the one we ship: `extraResources` copies a single
 * `dist-operon-runtime` into both the arm64 and x86_64 apps (see
 * `build-all-mac.sh`), so a per-arch binary would be wrong in one of them.
 *
 * Idempotent: an existing binary reporting the pinned version is left alone,
 * which keeps it out of the way of repeated `npm run build`.
 *
 *   node scripts/fetch-cua-driver.mjs [--force]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Pinned deliberately: an engine that drives the user's Mac is not something to
 *  float on "latest". Bump it in a commit, with the checksum below. */
const VERSION = "0.23.2";
const ASSET = `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`;
const URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/${ASSET}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "dist-operon-runtime");
const target = path.join(outdir, "cua-driver");
const force = process.argv.includes("--force");

if (process.platform !== "darwin") {
  console.log("cua-driver: skipping, macOS only");
  process.exit(0);
}

if (!force && existsSync(target) && installedVersion() === VERSION) {
  console.log(`cua-driver ${VERSION} already present`);
  process.exit(0);
}

function installedVersion() {
  try {
    return execFileSync(target, ["--version"], { encoding: "utf8" }).trim().split(/\s+/).pop();
  } catch {
    return undefined;
  }
}

console.log(`cua-driver: downloading ${VERSION}…`);
const response = await fetch(URL);
if (!response.ok) throw new Error(`cua-driver: ${URL} returned ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());

// The release publishes `checksums.txt` alongside the assets. Verifying against
// it is what makes downloading a binary we then ship inside our own signed app
// defensible at all.
const checksums = await fetch(URL.replace(ASSET, "checksums.txt"));
if (!checksums.ok) throw new Error(`cua-driver: checksums.txt returned ${checksums.status}`);
const expected = (await checksums.text())
  .split("\n")
  .map((line) => line.trim().split(/\s+/))
  .find(([, name]) => name?.replace(/^\*/, "") === ASSET)?.[0];
if (!expected) throw new Error(`cua-driver: ${ASSET} is not listed in checksums.txt`);
const actual = createHash("sha256").update(archive).digest("hex");
if (actual !== expected) {
  throw new Error(`cua-driver: checksum mismatch\n  expected ${expected}\n  actual   ${actual}`);
}

const staging = mkdtempSync(path.join(os.tmpdir(), "cua-driver-"));
try {
  const tarball = path.join(staging, ASSET);
  writeFileSync(tarball, archive);
  // Only the driver: the archive also carries an SDK dylib, a node addon and a
  // cursor-theme CLI, none of which this integration goes through.
  execFileSync("tar", ["xzf", tarball, "-C", staging, "cua-driver"]);
  mkdirSync(outdir, { recursive: true });
  const extracted = await readFile(path.join(staging, "cua-driver"));
  writeFileSync(target, extracted);
  chmodSync(target, 0o755);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

const version = installedVersion();
if (version !== VERSION) {
  throw new Error(`cua-driver: installed binary reports ${version ?? "nothing"}, expected ${VERSION}`);
}
console.log(`cua-driver ${VERSION} → ${path.relative(root, target)}`);
