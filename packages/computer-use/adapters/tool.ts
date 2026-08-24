import { z } from "zod";
import type { NodeReplSession, NodeReplRunResult } from "../NodeReplSession.ts";

// Optional zod tool adapter: wraps a persistent session as the
// `mcp__node_repl__js` tool.
// The core (NodeReplSession, Host, kernel) does not depend on zod; only this
// adapter does. Another framework can be supported by writing its own adapter
// the same way, without touching the core.

export const nodeReplInputSchema = z.object({
  code: z
    .string()
    .describe("JavaScript to run in the persistent Computer Use node_repl session (top-level await ok)"),
});

export const NODE_REPL_TOOL_DESCRIPTION =
  "Run JavaScript in a persistent Computer Use session. State (globalThis, `computer`, variables) " +
  "persists across calls. Use `computer.*` to drive local Mac apps and `nodeRepl.write(...)` for text output. " +
  "See the computer-use skill for the workflow and confirmation policy.";

export interface NodeReplTool {
  name: string;
  description: string;
  inputSchema: typeof nodeReplInputSchema;
  execute(args: { code: string }): Promise<NodeReplRunResult>;
}

export function createNodeReplTool(session: NodeReplSession): NodeReplTool {
  return {
    name: "node_repl_js", // surfaces to the model as mcp__node_repl__js
    description: NODE_REPL_TOOL_DESCRIPTION,
    inputSchema: nodeReplInputSchema,
    execute: (args) => session.run(args.code),
  };
}
