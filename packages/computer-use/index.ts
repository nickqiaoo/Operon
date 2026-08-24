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

// ---- Swift service lifecycle ----
export { ComputerUseService } from "./ComputerUseService.ts";
export type {
  ComputerUsePermissionKind,
  ComputerUsePermissions,
  ComputerUseServiceExit,
  ComputerUseServiceOptions,
} from "./ComputerUseService.ts";
export { decodeComputerUsePresentationEvent } from "./presentation.ts";
export type {
  ComputerUsePresentationEvent,
  ComputerUsePresentationEventType,
} from "./presentation.ts";

// ---- Sessions and the low-level host ----
export { NodeReplSession } from "./NodeReplSession.ts";
export type { NodeReplSessionOptions, NodeReplRunResult } from "./NodeReplSession.ts";
export { NodeReplHost } from "./NodeReplHost.ts";
export type { NodeReplHostOptions, ElicitationResult } from "./NodeReplHost.ts";

// ---- nodeRepl.config backend: browser security policy and approval memory ----
export { createTomlConfigStore, noopConfigStore } from "./configStore.ts";
export type { NodeReplConfigStore, TomlConfigStoreOptions } from "./configStore.ts";

// ---- Tool adapter (zod, optional) ----
export { createNodeReplTool, nodeReplInputSchema, NODE_REPL_TOOL_DESCRIPTION } from "./adapters/tool.ts";
export type { NodeReplTool } from "./adapters/tool.ts";

// ---- MCP server adapter: node_repl as an MCP server exposing a `js` tool ----
export { buildNodeReplMcpServer } from "./adapters/mcp.ts";
export type { NodeReplMcpServer } from "./adapters/mcp.ts";
