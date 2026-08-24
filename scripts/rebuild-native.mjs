import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

const skipValues = new Set(["1", "true", "yes"])
const skipRebuild = skipValues.has(String(process.env.SKIP_ELECTRON_REBUILD || "").toLowerCase())

if (skipRebuild) {
  console.log("[rebuild-native] Skipping Electron native rebuild (SKIP_ELECTRON_REBUILD set).")
  process.exit(0)
}

const require = createRequire(import.meta.url)

// No Electron, nothing to rebuild for. This is the normal state on a headless
// tunnel node, which installs with `--omit=dev` (electron is a devDependency)
// and runs the server under plain Node — the native modules it does use are
// already built for that ABI by their own install scripts. Without this the
// postinstall fails the whole install on a box that never wanted Electron.
let electronVersion
try {
  electronVersion = require("electron/package.json").version
} catch {
  console.log("[rebuild-native] Electron not installed — skipping (headless install).")
  process.exit(0)
}
const platform = process.platform
const targetArch = String(process.env.TARGET_ARCH || process.arch)
const lydellNodePtyVersion = "1.1.0"

function resolvePackageDir(name) {
  return path.dirname(require.resolve(`${name}/package.json`))
}

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`[rebuild-native] Missing ${label}: ${filePath}`)
    process.exit(1)
  }
}

const prebuildInstallBin = path.resolve(
  import.meta.dirname,
  "../node_modules/prebuild-install/bin.js",
)

const localPrebuildsDir = path.resolve(import.meta.dirname, "prebuilds")
const localPrebuildsArgs = fs.existsSync(localPrebuildsDir)
  ? ["--local-prebuilds", localPrebuildsDir]
  : []

function runPrebuildInstall(label, cwd, args, expectedArtifacts) {
  console.log(`[rebuild-native] Installing prebuilt ${label}...`)

  const result = spawnSync(
    process.execPath,
    [prebuildInstallBin, ...args],
    { cwd, stdio: "inherit" },
  )

  if (result.status !== 0) {
    console.error(`[rebuild-native] Failed to install prebuilt ${label}.`)
    process.exit(result.status ?? 1)
  }

  for (const artifact of expectedArtifacts) {
    ensureFileExists(path.join(cwd, artifact), `${label} artifact`)
  }

  console.log(`[rebuild-native] Prebuilt ${label} is ready.`)
}

function installPackageIfMissing(packageName, version, expectedArtifacts) {
  const packageDir = path.join(process.cwd(), "node_modules", ...packageName.split("/"))
  const missingArtifact = expectedArtifacts.find((artifact) => !fs.existsSync(path.join(packageDir, artifact)))

  if (!missingArtifact) {
    return packageDir
  }

  console.log(`[rebuild-native] Installing ${packageName} for ${platform}-${targetArch}...`)

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "operon-node-pty-"))
  const packResult = spawnSync(
    "npm",
    [
      "pack",
      `${packageName}@${version}`,
      "--pack-destination",
      tempDir,
      "--silent",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  )

  if (packResult.status !== 0) {
    console.error(packResult.stderr)
    console.error(`[rebuild-native] Failed to download ${packageName}.`)
    process.exit(packResult.status ?? 1)
  }

  const tarballName = fs.readdirSync(tempDir).find((entry) => entry.endsWith(".tgz"))
  if (!tarballName) {
    console.error(`[rebuild-native] npm pack did not produce a tarball for ${packageName}.`)
    process.exit(1)
  }

  fs.rmSync(packageDir, { recursive: true, force: true })
  fs.mkdirSync(packageDir, { recursive: true })

  const tarResult = spawnSync(
    "tar",
    [
      "-xzf",
      path.join(tempDir, tarballName),
      "--strip-components=1",
      "-C",
      packageDir,
    ],
    { cwd: process.cwd(), stdio: "inherit" },
  )

  fs.rmSync(tempDir, { recursive: true, force: true })

  if (tarResult.status !== 0) {
    console.error(`[rebuild-native] Failed to extract ${packageName}.`)
    process.exit(tarResult.status ?? 1)
  }

  for (const artifact of expectedArtifacts) {
    ensureFileExists(path.join(packageDir, artifact), `${packageName} artifact`)
  }

  return packageDir
}

function prepareLydellNodePtyPrebuilt() {
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(targetArch)) {
    console.log(`[rebuild-native] Skipping @lydell/node-pty for unsupported target ${platform}-${targetArch}.`)
    return
  }

  const packageName = `@lydell/node-pty-${platform}-${targetArch}`
  const expectedArtifacts = platform === "darwin" ? ["pty.node", "spawn-helper"] : ["pty.node"]
  const packageDir = installPackageIfMissing(packageName, lydellNodePtyVersion, expectedArtifacts)
  const helperPath = path.join(packageDir, "spawn-helper")

  if (fs.existsSync(helperPath)) {
    fs.chmodSync(helperPath, 0o755)
  }

  console.log(`[rebuild-native] @lydell/node-pty prebuilt is ready (${platform}-${targetArch}).`)
}

/**
 * sqlite-vec ships its loadable extension in per-platform packages gated by
 * `os` / `cpu`, so a plain `npm install` on an arm64 Mac never fetches
 * `sqlite-vec-darwin-x64`. Cross-building the Intel app would then package an
 * app whose memory feature cannot open vec0. Fetch the target's package
 * explicitly, exactly as we do for @lydell/node-pty above.
 */
function prepareSqliteVecPrebuilt() {
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(targetArch)) {
    console.log(`[rebuild-native] Skipping sqlite-vec for unsupported target ${platform}-${targetArch}.`)
    return
  }
  // win32 only publishes x64.
  if (platform === "win32" && targetArch !== "x64") {
    console.log("[rebuild-native] Skipping sqlite-vec: no windows-arm64 build published.")
    return
  }

  let version
  try {
    const root = require(path.resolve(import.meta.dirname, "../package.json"))
    version = root.optionalDependencies?.["sqlite-vec"]
  } catch {
    version = undefined
  }
  if (!version) {
    console.log("[rebuild-native] sqlite-vec not in optionalDependencies, skipping.")
    return
  }

  const osName = platform === "win32" ? "windows" : platform
  const suffix = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so"
  installPackageIfMissing(`sqlite-vec-${osName}-${targetArch}`, version, [`vec0.${suffix}`])

  console.log(`[rebuild-native] sqlite-vec extension is ready (${platform}-${targetArch}).`)
}

runPrebuildInstall(
  "better-sqlite3",
  resolvePackageDir("better-sqlite3"),
  [
    "--runtime", "electron",
    "--target", electronVersion,
    "--arch", targetArch,
    "--dist-url", "https://electronjs.org/headers",
    "--verbose",
    ...localPrebuildsArgs,
  ],
  ["build/Release/better_sqlite3.node"],
)

try {
  runPrebuildInstall(
    "keytar",
    resolvePackageDir("keytar"),
    ["--arch", targetArch, "--verbose"],
    ["build/Release/keytar.node"],
  )
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "MODULE_NOT_FOUND") {
    console.log("[rebuild-native] keytar not installed, skipping.")
  } else {
    throw error
  }
}

prepareLydellNodePtyPrebuilt()
prepareSqliteVecPrebuilt()

console.log("[rebuild-native] Native prebuilt preparation completed.")
