import { build } from "esbuild";
import { createRequire } from "node:module";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "dist-operon-runtime");
const require_ = createRequire(import.meta.url);
const playwrightDir = path.dirname(require_.resolve("playwright-core/package.json"));
const injectedModule = require_(path.join(
  playwrightDir,
  "lib/generated/injectedScriptSource.js",
));
if (typeof injectedModule.source !== "string") {
  throw new Error("playwright-core injectedScriptSource has no source string");
}

await Promise.all([
  "browser-client.js",
  "computer-use-client.js",
  "node-repl-kernel.js",
  "site-adapters.js",
  "connectors",
  "docs",
  "skills",
].map((entry) => rm(path.join(outdir, entry), { recursive: true, force: true })));

const embedPlaywrightInjected = {
  name: "embed-playwright-injected",
  setup(buildContext) {
    buildContext.onResolve(
      { filter: /playwright-injected-source\.ts$/ },
      () => ({ path: "playwright-injected-source", namespace: "operon-runtime" }),
    );
    buildContext.onLoad(
      { filter: /.*/, namespace: "operon-runtime" },
      () => ({
        contents: `export function loadPlaywrightInjectedSource() { return ${JSON.stringify(injectedModule.source)}; }`,
        loader: "js",
      }),
    );
  },
};

const result = await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: {
    "browser-client": "packages/browser-use/sdk/runtime.ts",
    "computer-use-client": "packages/computer-use/runtime.ts",
    "node-repl-kernel": "packages/computer-use/kernel/entry.ts",
    "site-adapters": "packages/site-adapters/index.ts",
  },
  entryNames: "[name]",
  format: "esm",
  outdir,
  platform: "node",
  plugins: [embedPlaywrightInjected],
  sourcemap: false,
  splitting: false,
  target: "node20",
  metafile: true,
});

const proprietaryInputs = Object.keys(result.metafile.inputs).filter(
  (input) =>
    input.includes("/vendor/codex-browser-client/") ||
    input.endsWith("/assets/sky.bundle.mjs") ||
    input.endsWith("/vendor/oai-sky/sky.bundle.mjs"),
);
if (proprietaryInputs.length > 0) {
  throw new Error(`runtime bundle unexpectedly contains proprietary inputs: ${proprietaryInputs.join(", ")}`);
}

await Promise.all([
  cp(
    path.join(root, "packages", "browser-use", "docs"),
    path.join(outdir, "docs"),
    { recursive: true },
  ),
  cp(
    path.join(root, "packages", "browser-use", "skill"),
    path.join(outdir, "skills", "browser"),
    { recursive: true },
  ),
  cp(
    path.join(root, "packages", "computer-use", "skill"),
    path.join(outdir, "skills", "computer"),
    { recursive: true },
  ),
  cp(
    path.join(root, "packages", "site-adapters", "skill", "site-adapters"),
    path.join(outdir, "skills", "site-adapters"),
    { recursive: true },
  ),
  cp(
    path.join(root, "packages", "workflow", "skill"),
    path.join(outdir, "skills", "workflow"),
    { recursive: true },
  ),
  cp(
    path.join(root, "server", "src", "services", "connectors", "connectors.index.json"),
    path.join(outdir, "connectors", "connectors.index.json"),
  ),
]);
