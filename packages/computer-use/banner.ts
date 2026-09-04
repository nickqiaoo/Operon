import type { NodeReplSurface } from "./adapters/tool.ts";

/**
 * The banner: runtime setup that runs once per kernel, before the model's first
 * line of code.
 *
 * ## Why this exists
 *
 * Every skill used to open with an idempotent bootstrap guard the model had to
 * copy by hand:
 *
 * ```js
 * if (!globalThis.computer) {
 *   const clientPath = nodeRepl.env?.OPERON_COMPUTER_USE_CLIENT_PATH;
 *   const { setupComputerUseRuntime } = await import(clientPath);
 *   await setupComputerUseRuntime({ globals: globalThis });
 * }
 * ```
 *
 * That cost a turn per session at best. At worst the model never read the skill
 * (skills are loaded lazily), called `computer.click(...)` straight away, got a
 * ReferenceError, and started guessing at APIs. Two surfaces meant two guards,
 * and writing only one of them was a common way to half-fail.
 *
 * Codex solves this with `NODE_REPL_JS_BANNER`, a string its launcher passes to
 * the kernel, which splices it in front of the first cell. We do the same, minus
 * the environment-variable round trip: our MCP server is built per session in
 * process, so the banner is just an option (see NodeReplSession).
 *
 * ## Failure handling
 *
 * Each surface is guarded separately and records its failure rather than
 * throwing. A missing Computer Use client must not take the browser down with
 * it, and a silent failure would put us back in ReferenceError-and-guess
 * territory — so anything that went wrong is written into the first tool result
 * where the model will read it.
 *
 * The env var names below are the model-facing contract, injected by
 * `buildEntry` in server/src/routes/node-repl-mcp.ts:
 * `OPERON_COMPUTER_USE_CLIENT_PATH_ENV` (packages/computer-use/index.ts) and
 * `OPERON_BROWSER_CLIENT_PATH_ENV` (packages/browser-use/index.ts). They are
 * spelled out rather than imported because this package does not depend on
 * @operon/browser-use.
 */

const COMPUTER_CHUNK = `
try {
  if (!globalThis.computer) {
    const clientPath = nodeRepl.env?.OPERON_COMPUTER_USE_CLIENT_PATH;
    if (typeof clientPath !== "string" || clientPath.length === 0) {
      throw new Error("OPERON_COMPUTER_USE_CLIENT_PATH is not set");
    }
    const { setupComputerUseRuntime } = await import(clientPath);
    await setupComputerUseRuntime({ globals: globalThis });
  }
} catch (e) {
  __operonSetupErrors.push("Computer Use (computer.*): " + (e?.message ?? String(e)));
}`;

const BROWSER_CHUNK = `
try {
  if (globalThis.agent?.browsers == null) {
    const clientPath = nodeRepl.env?.OPERON_BROWSER_CLIENT_PATH;
    if (typeof clientPath !== "string" || clientPath.length === 0) {
      throw new Error("OPERON_BROWSER_CLIENT_PATH is not set");
    }
    const { setupBrowserRuntime } = await import(clientPath);
    await setupBrowserRuntime({ globals: globalThis });
  }
} catch (e) {
  __operonSetupErrors.push("Browser (agent.browsers): " + (e?.message ?? String(e)));
}`;

/**
 * Build the banner for the enabled surfaces, or `undefined` when there is
 * nothing to install.
 *
 * `browser` and `chrome` share one runtime — they are the same `agent.browsers`
 * with different backends — so the browser chunk is emitted once for either.
 */
export function buildNodeReplBanner(surfaces: readonly NodeReplSurface[]): string | undefined {
  const enabled = new Set(surfaces);
  const chunks: string[] = [];
  if (enabled.has("computer")) chunks.push(COMPUTER_CHUNK);
  if (enabled.has("browser") || enabled.has("chrome")) chunks.push(BROWSER_CHUNK);
  if (chunks.length === 0) return undefined;
  return [
    "const __operonSetupErrors = [];",
    ...chunks,
    `
if (__operonSetupErrors.length > 0) {
  nodeRepl.write(
    "node_repl runtime setup incomplete:\\n- " + __operonSetupErrors.join("\\n- ") + "\\n",
  );
}`,
  ].join("\n");
}
