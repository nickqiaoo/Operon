import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildNodeReplMcpServer } from "./adapters/mcp.ts";
import { createNodeReplTool } from "./adapters/tool.ts";
import { NodeReplSession } from "./NodeReplSession.ts";

describe("operonrepl public tool contract", () => {
  it("advertises operonrepl and executes both js and js_reset through MCP", async () => {
    const { server, dispose } = await buildNodeReplMcpServer({
      driver: { socketPath: "/tmp/operonrepl-contract-unused.sock", autoStart: false },
      surfaces: [],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "operonrepl-contract", version: "1" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      expect(client.getServerVersion()?.name).toBe("operonrepl");
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["js", "js_reset"]);
      for (const tool of tools) {
        expect(tool.description).toContain("operonrepl");
        expect(tool.description).not.toContain("node_repl");
      }
      await client.callTool({ name: "js", arguments: { source: 'globalThis.saved = "retained";' } });
      const before = await client.callTool({ name: "js", arguments: { source: "nodeRepl.write(globalThis.saved);" } });
      expect(before.isError).not.toBe(true);
      expect(before.content).toEqual([{ type: "text", text: "retained" }]);
      const reset = await client.callTool({ name: "js_reset", arguments: {} });
      expect(reset.isError).not.toBe(true);
      expect(reset.content).toEqual([{ type: "text", text: "operonrepl session reset. Browser tabs and apps are unaffected." }]);
      const after = await client.callTool({ name: "js", arguments: { source: "return typeof globalThis.saved;" } });
      expect(after.isError).not.toBe(true);
      expect(after.content).toEqual([{ type: "text", text: "undefined" }]);
    } finally {
      await client.close();
      await server.close();
      await dispose();
    }
  }, 20_000);

  it("exposes the framework adapter under the same namespace", async () => {
    const session = new NodeReplSession({ socketPath: "/tmp/operonrepl-contract-unused.sock" });
    try {
      const tool = createNodeReplTool(session);
      expect(tool.name).toBe("operonrepl_js");
      expect((await tool.execute({ code: "return 1 + 1;" })).result).toBe(2);
    } finally {
      await session.dispose();
    }
  });
});
