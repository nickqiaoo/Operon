import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildNodeReplMcpServer } from "./mcp.ts";

// Executable stdio MCP server entry point. Operon, or any MCP host, points at it
// from mcp.json:
//   { "node_repl": { "command": "node", "args": ["--import","tsx", "<pkg>/adapters/mcp-server.ts"] } }
//   In production this should point at a pre-bundled .mjs. Setting
//   OPERON_CU_SOCKET reuses an already-running Swift service.

const socketPath = process.env.OPERON_CU_SOCKET;
const binaryPath = process.env.OPERON_CU_BINARY;

const { server, dispose } = await buildNodeReplMcpServer({
  service: {
    ...(socketPath ? { socketPath, autoStart: false } : {}),
    ...(binaryPath ? { binaryPath } : {}),
  },
});

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => {
  try {
    await dispose();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
