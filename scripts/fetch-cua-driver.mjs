/**
 * Fetch the `cua-driver` daemon into `dist-operon-runtime/`, thinned to one arch.
 *
 * cua-driver is the Computer Use engine (trycua/cua, MIT). Unlike the Swift
 * engine it was never built from this repo — upstream publishes signed release
 * binaries — so this downloads one rather than compiling ~13 Rust crates on
 * every machine.
 *
 * **Upstream's per-arch assets are a red herring.** `darwin-arm64.tar.gz` and
 * `darwin-x86_64.tar.gz` both carry the *same universal* `cua-driver`, byte for
 * byte identical to the one in `darwin-universal-binary.tar.gz` (61,867,824
 * bytes, `lipo -archs` reports both slices). Downloading the "matching" asset
 * would save nothing, so we take the universal archive and run `lipo -thin`
 * ourselves: 61.9 MB becomes 29.9 MB on arm64 and 32.0 MB on x86_64, off both
 * the dmg the user downloads and the zip the notarize step uploads to Apple.
 * Each slice of a universal binary carries its own signature, so the thinned
 * file is still validly signed (electron-builder re-signs it as ours anyway).
 *
 * Arch-specific, so it must run once per arch, like `build:native-addons`. Both
 * passes in `build-all-mac.sh` are separate builds separated by `clean:build`,
 * which is what makes a per-arch artifact correct here.
 *
 * Idempotent via the stamp file next to the binary: the arch is read with
 * `lipo`, never by executing the binary, because a cross-compiled build has a
 * driver it cannot run.
 *
 *   node scripts/fetch-cua-driver.mjs [--force]      # TARGET_ARCH=arm64|x64
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Pinned deliberately: an engine that drives the user's Mac is not something to
 *  float on "latest". Bump it in a commit, with the checksum below. */
const VERSION = "0.23.2";
const ASSET = `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`;
const URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/${ASSET}`;

/** Node's arch names (what TARGET_ARCH is spelled in) to Mach-O's (what lipo
 *  wants). The rest of the build speaks the left column; lipo only knows the
 *  right one. */
const MACHO_ARCH = { arm64: "arm64", aarch64: "arm64", x64: "x86_64", x86_64: "x86_64" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "dist-operon-runtime");
const target = path.join(outdir, "cua-driver");
const stampPath = path.join(outdir, ".cua-driver.json");
const force = process.argv.includes("--force");

if (process.platform !== "darwin") {
  console.log("cua-driver: skipping, macOS only");
  process.exit(0);
}

const requestedArch = process.env.TARGET_ARCH ?? process.env.npm_config_arch ?? process.arch;
const arch = MACHO_ARCH[requestedArch];
if (!arch) throw new Error(`cua-driver: unsupported TARGET_ARCH ${requestedArch}`);
const hostArch = MACHO_ARCH[process.arch];

/** Architectures present in a Mach-O file, without running it. */
function archsOf(file) {
  try {
    return execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim().split(/\s+/);
  } catch {
    return [];
  }
}

function readStamp() {
  try {
    return JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return undefined;
  }
}

const stamp = readStamp();
if (
  !force
  && existsSync(target)
  && stamp?.version === VERSION
  && stamp?.arch === arch
  && archsOf(target).join() === arch
) {
  console.log(`cua-driver ${VERSION} (${arch}) already present`);
  process.exit(0);
}

/** GitHub release downloads through a proxy drop mid-handshake often enough
 *  (ECONNRESET) that one attempt fails a whole build-all; retry with backoff. */
async function fetchWithRetry(url, read, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`cua-driver: ${url} returned ${res.status}`);
      return await read(res);
    } catch (err) {
      if (i >= attempts) throw err;
      const delay = 1000 * 2 ** (i - 1);
      console.warn(`cua-driver: ${err.cause?.code ?? err.message}, retrying in ${delay / 1000}s (${i}/${attempts - 1})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

console.log(`cua-driver: downloading ${VERSION}…`);
const archive = await fetchWithRetry(URL, async (res) => Buffer.from(await res.arrayBuffer()));

// The release publishes `checksums.txt` alongside the assets. Verifying against
// it is what makes downloading a binary we then ship inside our own signed app
// defensible at all.
const checksumsText = await fetchWithRetry(URL.replace(ASSET, "checksums.txt"), (res) => res.text());
const expected = checksumsText
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
  const extracted = path.join(staging, "cua-driver");

  const present = archsOf(extracted);
  if (!present.includes(arch)) {
    throw new Error(`cua-driver: ${ASSET} has no ${arch} slice (found ${present.join(", ") || "none"})`);
  }
  const thinned = path.join(staging, `cua-driver-${arch}`);
  if (present.length > 1) {
    execFileSync("lipo", ["-thin", arch, extracted, "-output", thinned]);
  } else {
    renameSync(extracted, thinned);
  }

  mkdirSync(outdir, { recursive: true });
  rmSync(target, { force: true });
  writeFileSync(target, readFileSync(thinned));
  chmodSync(target, 0o755);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

if (archsOf(target).join() !== arch) {
  throw new Error(`cua-driver: thinning produced ${archsOf(target).join(", ") || "nothing"}, expected ${arch}`);
}
// Only runnable when it was built for this machine; a cross-arch build has to
// trust the checksum and the slice check above.
if (arch === hostArch) {
  const reported = execFileSync(target, ["--version"], { encoding: "utf8" }).trim().split(/\s+/).pop();
  if (reported !== VERSION) {
    throw new Error(`cua-driver: installed binary reports ${reported ?? "nothing"}, expected ${VERSION}`);
  }
}

writeFileSync(stampPath, `${JSON.stringify({ version: VERSION, arch }, null, 2)}\n`);
const mb = (readFileSync(target).byteLength / 1024 / 1024).toFixed(1);
console.log(`cua-driver ${VERSION} (${arch}, ${mb} MB) → ${path.relative(root, target)}`);
