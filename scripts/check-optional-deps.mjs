/**
 * Preflight for the Electron packaging chain.
 *
 * `sqlite-vec` and `node-llama-cpp` are optionalDependencies, so npm skips them
 * *silently* when their install fails — `npm install` still exits 0. Nothing
 * downstream notices either: electron-builder collects whatever is actually in
 * node_modules, and a missing optional package is simply absent from the
 * dependency tree (verified: with `node_modules/sqlite-vec` moved aside,
 * `app-builder node-dep-tree` exits 0 with the package gone from its output).
 *
 * The result is a signed, notarised build whose memory feature throws
 * MODULE_NOT_FOUND on the user's machine. This turns that into a build-time
 * failure instead.
 *
 * Both packages split into a JS entry package plus a per-platform binary
 * package, and both halves are required at runtime — the entry package is what
 * `sqlite-vec-store.ts` / `local-llm.ts` import, the platform package carries
 * the .dylib / .node they load. Check both.
 *
 * Skipped when memory is compiled out (`ENABLE_MEMORY=false`, matching
 * vite.config.ts), since nothing then reaches this code.
 */
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * `require.resolve(name)` alone is not enough: the platform packages ship a
 * binary with no importable entry point, and `require.resolve(name + "/package.json")`
 * is blocked by the `exports` field on packages like sqlite-vec. Fall back to
 * looking the directory up under node_modules, which is what electron-builder's
 * collector does anyway.
 */
function isInstalled(name) {
  try {
    require.resolve(name)
    return true
  } catch {
    return existsSync(path.join(projectRoot, "node_modules", name, "package.json"))
  }
}

if (process.env.ENABLE_MEMORY === "false") {
  console.log("[check-optional-deps] ENABLE_MEMORY=false — memory is compiled out, skipping.")
  process.exit(0)
}

const platform = process.platform
const arch = String(process.env.TARGET_ARCH || process.arch)

// Platform package names, keyed `${platform}-${arch}`. Only the combinations we
// actually ship are listed; an unknown host just checks the entry packages.
const SQLITE_VEC_PLATFORM = {
  "darwin-arm64": "sqlite-vec-darwin-arm64",
  "darwin-x64": "sqlite-vec-darwin-x64",
  "linux-arm64": "sqlite-vec-linux-arm64",
  "linux-x64": "sqlite-vec-linux-x64",
  "win32-x64": "sqlite-vec-windows-x64",
}

const LLAMA_PLATFORM = {
  "darwin-arm64": "@node-llama-cpp/mac-arm64-metal",
  "darwin-x64": "@node-llama-cpp/mac-x64",
  "linux-arm64": "@node-llama-cpp/linux-arm64",
  "linux-x64": "@node-llama-cpp/linux-x64",
  "win32-x64": "@node-llama-cpp/win-x64",
}

const key = `${platform}-${arch}`

// Entry packages are pure JS and always installable on any host, so their
// absence is unambiguously a broken install — hard failure.
const entry = [
  { name: "sqlite-vec", why: "vector store entry point (getLoadablePath)" },
  { name: "node-llama-cpp", why: "embedding + rerank runtime" },
]

// Platform packages are gated on os/cpu, so npm only ever installs the host's
// own. Cross-arch builds (`build:mac:intel` from an arm64 machine) therefore
// cannot have them, which is a pre-existing limitation rather than a broken
// install — warn instead of failing, so the intel build still runs.
const platformPkgs = []
if (SQLITE_VEC_PLATFORM[key]) {
  platformPkgs.push({ name: SQLITE_VEC_PLATFORM[key], why: "vec0 loadable extension for this platform" })
}
if (LLAMA_PLATFORM[key]) {
  platformPkgs.push({ name: LLAMA_PLATFORM[key], why: "llama.cpp binary for this platform" })
}

const missingPlatform = platformPkgs.filter((dep) => !isInstalled(dep.name))
if (missingPlatform.length > 0) {
  const crossArch = arch !== process.arch
  console.warn("")
  console.warn(`[check-optional-deps] WARNING: no ${key} binaries in node_modules:`)
  for (const dep of missingPlatform) console.warn(`  - ${dep.name}  (${dep.why})`)
  console.warn(
    crossArch
      ? `  Host is ${process.arch}; npm cannot install ${arch} binaries here. Memory will be`
      : "  Memory will be",
  )
  console.warn("  unavailable in this build. Not failing — the rest of the app is unaffected.")
  console.warn("")
}

const missing = entry.filter((dep) => !isInstalled(dep.name))

if (missing.length > 0) {
  console.error("")
  console.error("[check-optional-deps] Missing optional dependencies:")
  for (const dep of missing) {
    console.error(`  - ${dep.name}  (${dep.why})`)
  }
  console.error("")
  console.error("  These are optionalDependencies, so `npm install` skipped them without")
  console.error("  failing, and electron-builder would ship a package whose memory feature")
  console.error("  throws MODULE_NOT_FOUND at runtime.")
  console.error("")
  console.error(`  Fix:  npm install ${missing.map((d) => d.name).join(" ")} --no-save`)
  console.error("  Or build without memory:  ENABLE_MEMORY=false npm run build:mac")
  console.error("")
  process.exit(1)
}

console.log(
  `[check-optional-deps] OK — ${entry.length + platformPkgs.length - missingPlatform.length} memory packages present for ${key}.`,
)
