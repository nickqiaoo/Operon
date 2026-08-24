import { createRequire } from "node:module";
import path from "node:path";

/**
 * In development the injectedScript is read from the installed playwright-core.
 * The production bundle has it embedded directly by
 * scripts/build-operon-runtime.mjs, so it does not depend on node_modules at
 * runtime.
 */
export function loadPlaywrightInjectedSource(): string {
  const require_ = createRequire(import.meta.url);
  const pkgDir = path.dirname(require_.resolve("playwright-core/package.json"));
  const mod = require_(path.join(pkgDir, "lib/generated/injectedScriptSource.js")) as { source?: unknown };
  if (typeof mod.source !== "string") {
    throw new Error("playwright-core injectedScriptSource has no `source` string");
  }
  return mod.source;
}
