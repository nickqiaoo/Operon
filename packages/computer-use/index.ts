// operon Computer Use: the node_repl runtime.
// A standalone module with no coupling to operon itself; wiring it into any
// framework only requires implementing ComputerUseIntegration.

/** Exposed inside nodeRepl.env so the managed skill never hard-codes an app path. */
export const OPERON_COMPUTER_USE_CLIENT_PATH_ENV = "OPERON_COMPUTER_USE_CLIENT_PATH";

export { setupComputerUseRuntime } from "./runtime.ts";
export type { SetupComputerUseRuntimeOptions } from "./runtime.ts";

// ---- Top-level entry point (recommended) ----
export { createComputerUse } from "./createComputerUse.ts";
export type { CreateComputerUseOptions, ComputerUseHandle } from "./createComputerUse.ts";

// ---- Integration contract ----
export type { ComputerUseIntegration } from "./integration.ts";
export { defaultIntegration } from "./integration.ts";

// ---- Engine lifecycle ----
// The cua-driver daemon is the only engine; the Swift service that used to be
// the other option no longer has a TypeScript half. See computer/backend.ts.
export { CuaDriverService } from "./CuaDriverService.ts";
export type { CuaDriverServiceOptions } from "./CuaDriverService.ts";
export { CUA_DRIVER_SOCKET_ENV } from "./computer/backend.ts";

// ---- Sessions and the low-level host ----
export { NodeReplSession } from "./NodeReplSession.ts";
export type { NodeReplSessionOptions, NodeReplRunResult } from "./NodeReplSession.ts";
export { NodeReplHost } from "./NodeReplHost.ts";
export type { NodeReplHostOptions, ElicitationResult } from "./NodeReplHost.ts";

// ---- nodeRepl.config backend: browser security policy and approval memory ----
export { createTomlConfigStore, noopConfigStore } from "./configStore.ts";
export type { NodeReplConfigStore, TomlConfigStoreOptions } from "./configStore.ts";

// ---- Tool adapter (zod, optional) ----
export {
  createNodeReplTool,
  nodeReplInputSchema,
  NODE_REPL_TOOL_DESCRIPTION,
  JS_RESET_TOOL_DESCRIPTION,
  buildNodeReplToolDescription,
  ALL_NODE_REPL_SURFACES,
  clampNodeReplOutput,
  DEFAULT_OUTPUT_TOKEN_LIMIT,
} from "./adapters/tool.ts";
export type { NodeReplTool, NodeReplSurface } from "./adapters/tool.ts";

// Runtime setup spliced in before the model's first cell (see banner.ts).
export { buildNodeReplBanner } from "./banner.ts";

// ---- MCP server adapter: node_repl as an MCP server exposing a `js` tool ----
export { buildNodeReplMcpServer } from "./adapters/mcp.ts";
export type { NodeReplMcpServer, NodeReplMcpServerOptions } from "./adapters/mcp.ts";
