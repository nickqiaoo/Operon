import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { NodeReplSession } from "./NodeReplSession.ts";
import { buildNodeReplMcpServer } from "./index.ts";
import {
  resolveCodexSessionId,
  CODEX_TURN_METADATA_HEADER,
  type CodexTurnMetadata,
} from "./ipc.ts";

/**
 * The turn metadata contract.
 *
 * Established by recording the reference browser client:
 *   function ze(){ return globalThis.nodeRepl?.requestMeta?.["x-codex-turn-metadata"] }
 *   function Yt(t=ze()){
 *     if (t?.thread_source === "subagent" && typeof t.thread_id === "string") return t.thread_id;
 *     let e = t?.session_id; return typeof e === "string" ? e : undefined;
 *   }
 *
 * The probe below reads the metadata the same way a consumer would, rather than
 * asserting our own internal structure. That way the tests go red when the
 * contract drifts, and stay green through a refactor.
 */

// A probe equivalent to how consumers read this.
const PROBE = `
  const ze = () => nodeRepl?.requestMeta?.["${CODEX_TURN_METADATA_HEADER}"];
  const Yt = (t = ze()) => {
    if (t?.thread_source === "subagent" && typeof t.thread_id === "string") return t.thread_id;
    return typeof t?.session_id === "string" ? t.session_id : undefined;
  };
  const m = ze();
  return {
    sessionId: Yt(),
    turnId: m?.turn_id,
    operonSessionId: m?.operon_session_id,
    tmpDir: typeof nodeRepl.tmpDir,
    homeDir: typeof nodeRepl.homeDir,
    cwd: typeof nodeRepl.cwd,
  };
`;

interface Probe {
  sessionId?: string;
  turnId?: string;
  operonSessionId?: string;
  tmpDir: string;
  homeDir: string;
  cwd: string;
}

describe("resolveCodexSessionId", () => {
  it("an ordinary session uses session_id", () => {
    expect(resolveCodexSessionId({ session_id: "s1", turn_id: "t1" })).toBe("s1");
  });

  it("a subagent uses thread_id in place of session_id", () => {
    expect(
      resolveCodexSessionId({
        session_id: "parent",
        turn_id: "t1",
        thread_source: "subagent",
        thread_id: "thr-X",
      }),
    ).toBe("thr-X");
  });

  it("a thread_source other than subagent still uses session_id", () => {
    expect(
      resolveCodexSessionId({ session_id: "s1", thread_source: "main", thread_id: "thr-X" }),
    ).toBe("s1");
  });

  it("a subagent whose thread_id is not a string falls back to session_id", () => {
    expect(resolveCodexSessionId({ session_id: "s1", thread_source: "subagent" })).toBe("s1");
  });

  it("absence returns undefined, which is what makes the browser client throw", () => {
    expect(resolveCodexSessionId(undefined)).toBeUndefined();
    expect(resolveCodexSessionId({ turn_id: "t1" })).toBeUndefined();
  });
});

describe("turn metadata reaching the kernel", () => {
  it("session_id and turn_id are readable the documented way, and tmpDir, homeDir and cwd are all present", async () => {
    const s = new NodeReplSession({ socketPath: "/tmp/opcu-turnmeta-unused.sock" });
    try {
      const { result } = await s.run(PROBE, { session_id: "sess-A", turn_id: "turn-1" });
      const p = result as Probe;
      expect(p.sessionId).toBe("sess-A");
      expect(p.turnId).toBe("turn-1");
      // tmpDir has to have a value: the read tests whether nodeRepl exists, not
      // whether tmpDir does, so omitting it yields undefined.
      expect(p.tmpDir).toBe("string");
      expect(p.homeDir).toBe("string");
      expect(p.cwd).toBe("string");
    } finally {
      await s.dispose();
    }
  }, 20_000);

  it("turn_id refreshes each turn: the kernel outlives one and must not freeze at fork time", async () => {
    const s = new NodeReplSession({ socketPath: "/tmp/opcu-turnmeta-unused.sock" });
    try {
      const a = (await s.run(PROBE, { session_id: "sess-A", turn_id: "turn-1" })).result as Probe;
      const b = (await s.run(PROBE, { session_id: "sess-A", turn_id: "turn-2" })).result as Probe;
      expect(a.turnId).toBe("turn-1");
      expect(b.turnId).toBe("turn-2"); // Frozen, this would still be turn-1.
      expect(b.sessionId).toBe("sess-A");
    } finally {
      await s.dispose();
    }
  }, 20_000);

  it("on a subagent turn, the session_id resolved inside the kernel is the thread_id", async () => {
    const s = new NodeReplSession({ socketPath: "/tmp/opcu-turnmeta-unused.sock" });
    try {
      const { result } = await s.run(PROBE, {
        session_id: "parent",
        turn_id: "turn-3",
        thread_source: "subagent",
        thread_id: "thr-X",
      });
      expect((result as Probe).sessionId).toBe("thr-X");
    } finally {
      await s.dispose();
    }
  }, 20_000);

  it("omitting turnMetadata keeps the previous turn's, which is valid for Computer Use since it tolerates absence", async () => {
    const s = new NodeReplSession({ socketPath: "/tmp/opcu-turnmeta-unused.sock" });
    try {
      await s.run(PROBE, { session_id: "sess-A", turn_id: "turn-1" });
      const { result } = await s.run(PROBE);
      expect((result as Probe).turnId).toBe("turn-1");
    } finally {
      await s.dispose();
    }
  }, 20_000);
});

/**
 * The full chain (see the comment in adapters/mcp.ts):
 *   agent loop -> `params._meta["x-codex-turn-metadata"]` on tools/call
 *     -> MCP adapter -> session.run(code, meta) -> the kernel's nodeRepl.requestMeta
 *
 * A real MCP client over InMemoryTransport, rather than calling the adapter's
 * internals: the point is that `_meta` survives the MCP protocol layer.
 */
/**
 * `await import(...)` in model code, which is the first line of a skill's
 * bootstrap:
 *   const { setupBrowserRuntime } = await import("<plugin root>/scripts/browser-client.mjs");
 * Dynamic import inside a vm requires an explicit `importModuleDynamically`
 * callback, or it fails at runtime with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING.
 * Computer Use never exposed this gap, because its client is preloaded and
 * injected by entry.ts rather than dynamically imported. Wiring up Browser Use is
 * what surfaced it.
 */
describe("dynamic import in the kernel", () => {
  it("model code can await import a builtin module", async () => {
    const s = new NodeReplSession({ socketPath: "/tmp/opcu-dynimport-unused.sock" });
    try {
      const { result } = await s.run(
        `const os = await import("node:os"); return typeof os.tmpdir;`,
        { session_id: "s", turn_id: "t" },
      );
      expect(result).toBe("function");
    } finally {
      await s.dispose();
    }
  }, 20_000);

  it("can await import an ESM file from disk, which is how the browser client is loaded", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dynimp-"));
    const file = path.join(dir, "mod.mjs");
    await fs.promises.writeFile(file, `export const hello = () => "from-disk";`);
    // The directory has to be on the import allowlist; only `node:` builtins are
    // permitted by default (see kernel-security.test.ts).
    const s = new NodeReplSession({
      socketPath: "/tmp/opcu-dynimport-unused.sock",
      processEnv: { NODE_REPL_TRUSTED_CODE_PATHS: dir },
    });
    try {
      const { result } = await s.run(
        `const m = await import(${JSON.stringify(file)}); return m.hello();`,
        { session_id: "s", turn_id: "t" },
      );
      expect(result).toBe("from-disk");
    } finally {
      await s.dispose();
    }
  }, 20_000);
});

describe("MCP _meta reaching nodeRepl.requestMeta", () => {
  async function callJs(
    meta?: Record<string, unknown>,
    fallbackTurnMetadata?: () => CodexTurnMetadata,
    turnMetadataAugment?: () => Partial<CodexTurnMetadata>,
  ) {
    const { server, dispose } = await buildNodeReplMcpServer({
      service: { socketPath: "/tmp/opcu-turnmeta-unused.sock", autoStart: false },
      fallbackTurnMetadata,
      turnMetadataAugment,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "turnmeta-test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = await client.callTool({
        name: "js",
        arguments: { source: PROBE },
        ...(meta ? { _meta: meta } : {}),
      });
      return JSON.stringify(res.content);
    } finally {
      await client.close();
      await dispose();
    }
  }

  it("turn metadata in _meta survives MCP and reaches the kernel", async () => {
    const text = await callJs({
      [CODEX_TURN_METADATA_HEADER]: { session_id: "sess-M", turn_id: "turn-M" },
    });
    expect(text).toContain("sess-M");
    expect(text).toContain("turn-M");
  }, 30_000);

  it("subagent: with thread_source in _meta, the kernel resolves thread_id", async () => {
    const text = await callJs({
      [CODEX_TURN_METADATA_HEADER]: {
        session_id: "parent",
        turn_id: "turn-M",
        thread_source: "subagent",
        thread_id: "thr-M",
      },
    });
    expect(text).toContain("thr-M");
    expect(text).not.toContain("parent");
  }, 30_000);

  it("a host sending no _meta is not an error here; each consumer decides", async () => {
    const text = await callJs();
    expect(text).not.toMatch(/Error/);
  }, 30_000);

  it("an HTTP host can fill in metadata for a client that sends none, using the session identity in the URL", async () => {
    const text = await callJs(undefined, () => ({
      session_id: "chat-42",
      turn_id: "host-turn-1",
    }));
    expect(text).toContain("chat-42");
    expect(text).toContain("host-turn-1");
  }, 30_000);

  it("host lifecycle fields merge in without overwriting the client's turn metadata", async () => {
    const text = await callJs(
      {
        [CODEX_TURN_METADATA_HEADER]: {
          session_id: "official-session",
          turn_id: "official-turn",
        },
      },
      undefined,
      () => ({ operon_session_id: "chat-42" }),
    );
    expect(text).toContain("official-session");
    expect(text).toContain("official-turn");
    expect(text).toContain("chat-42");
  }, 30_000);
});
