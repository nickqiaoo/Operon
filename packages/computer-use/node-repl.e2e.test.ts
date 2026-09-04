// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";
import { NodeReplHost, NodeReplSession, createNodeReplTool, createComputerUse, buildNodeReplMcpServer } from "./index.ts";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// End to end: a hand-written JSON-RPC ping sent from the kernel to the Swift
// service, answered with CodexComputerUseIPC-2. The full path is model code in
// the vm, then nodeRepl.nativePipe, then the host's net.connect, then the Swift
// domain socket, and back.

/** One kernel serves many vm contexts now, so a direct host test names its own. */
const T_CTX = "test";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SWIFT_BIN = path.join(REPO_ROOT, "native/computer-use/.build/debug/operon-computer-use");
const SOCK = "/tmp/opcu-nrtest.sock";

let swift: ChildProcess | undefined;

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

// These drive the real Swift engine, which only exists after `swift build` and
// only builds on macOS. Without it there is nothing to test against, so the
// suites below skip rather than fail.
const hasSwiftService = existsSync(SWIFT_BIN);

beforeAll(async () => {
  if (!hasSwiftService) return;
  rmSync(SOCK, { force: true });
  swift = spawn(SWIFT_BIN, [SOCK], { stdio: "ignore" });
  await waitFor(() => existsSync(SOCK), 8000);
});

afterAll(() => {
  swift?.kill();
  rmSync(SOCK, { force: true });
});

describe.skipIf(!hasSwiftService)("node_repl → host → Swift domain socket", () => {
  it("an afterSubmitted hook registered by a trusted module refreshes response metadata after a successful exec", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nrhook-"));
    const mod = path.join(dir, "hook.mjs");
    await fs.promises.writeFile(
      mod,
      `export function install() {
        globalThis.nodeRepl.addAfterSubmittedCodeHook({
          run() {
            globalThis.nodeRepl.setResponseMeta({
              "codex/toolSurface": { kind: "browserUse", hookRan: true }
            });
          }
        });
      }`,
    );
    const host = new NodeReplHost({
      processEnv: { NODE_REPL_TRUSTED_CODE_PATHS: dir },
    });
    await host.createContext(T_CTX);
    try {
      await host.exec(T_CTX, 
        `const m = await import(${JSON.stringify(mod)}); m.install(); return "ok";`,
      );
      expect(host.responseMetaFor(T_CTX)).toEqual({
        "codex/toolSurface": { kind: "browserUse", hookRan: true },
      });
    } finally {
      await host.dispose();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("a trusted module sends a ping over nativePipe by hand and gets CodexComputerUseIPC-2", async () => {
    // This has to go through a trusted module rather than using
    // `nodeRepl.nativePipe` from model code: with privilege separation the
    // sandbox's nodeRepl has no nativePipe (see kernel-security.test.ts). It is
    // also the real path, since both clients are imported into the kernel realm
    // and read the full nodeRepl from its globalThis.
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nrpipe-"));
    const mod = path.join(dir, "pinger.mjs");
    await fs.promises.writeFile(
      mod,
      `export async function ping(sock) {
        const conn = await globalThis.nodeRepl.nativePipe.createConnection(sock);
        const chunks = [];
        conn.on('data', (b) => chunks.push(b));
        const frame = (obj) => {
          const pl = Buffer.from(JSON.stringify(obj));
          const h = Buffer.alloc(4); h.writeUInt32LE(pl.length, 0);
          return Buffer.concat([h, pl]);
        };
        conn.write(frame({ id: 1, jsonrpc: '2.0', method: 'ping', params: { clientApiVersion: 'CodexComputerUseIPC-2' } }));
        return await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('ping timeout')), 5000);
          const iv = setInterval(() => {
            const buf = Buffer.concat(chunks);
            if (buf.length >= 4) {
              const len = buf.readUInt32LE(0);
              if (buf.length >= 4 + len) {
                clearInterval(iv); clearTimeout(t);
                resolve(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
              }
            }
          }, 10);
        });
      }`,
    );
    const host = new NodeReplHost({
      env: { SKY_CUA_NATIVE_PIPE_PATH: SOCK },
      processEnv: { NODE_REPL_TRUSTED_CODE_PATHS: dir },
    });
    await host.createContext(T_CTX);
    try {
      const resp = (await host.exec(T_CTX, 
        `const m = await import(${JSON.stringify(mod)});
         return await m.ping(nodeRepl.env.SKY_CUA_NATIVE_PIPE_PATH);`,
      )) as { result?: { serverApiVersion?: string } };
      expect(resp.result?.serverApiVersion).toBe("CodexComputerUseIPC-2");
    } finally {
      await host.dispose();
    }
  }, 30000);

  it("computer.list_apps() reaches Swift through the kernel and returns a real app list", async () => {
    const host = new NodeReplHost({ env: { SKY_CUA_NATIVE_PIPE_PATH: SOCK } });
    await host.createContext(T_CTX);
    try {
      const r = await host.exec(T_CTX, `
        if (typeof computer === 'undefined') return { clientLoadError: globalThis.__computerLoadError || 'computer undefined' };
        return await computer.list_apps();
      `);
      const s = JSON.stringify(r);
      expect(s).not.toMatch(/clientLoadError/);
      expect(s).toMatch(/com\.|running|frontmost/);
    } finally {
      await host.dispose();
    }
  }, 40000);

  it("process is not reachable inside the vm sandbox", async () => {
    const host = new NodeReplHost();
    await host.createContext(T_CTX);
    try {
      const r = (await host.exec(T_CTX, "return typeof process;")) as unknown;
      expect(r).toBe("undefined");
    } finally {
      await host.dispose();
    }
  }, 20000);
});

describe.skipIf(!hasSwiftService)("node_repl tool (agent-facing)", () => {
  it("tool.execute: computer.list_apps, captured write output, and state persisting across calls", async () => {
    const session = new NodeReplSession({ socketPath: SOCK });
    const tool = createNodeReplTool(session);
    try {
      const r = await tool.execute({
        code: "nodeRepl.write('hi\\n'); return await computer.list_apps();",
      });
      expect(r.output).toContain("hi");
      expect(JSON.stringify(r.result)).toMatch(/com\.|running/);

      // globalThis survives across calls: the session is persistent.
      await tool.execute({ code: "globalThis.__persist = 42;" });
      const r2 = await tool.execute({ code: "return globalThis.__persist;" });
      expect(r2.result).toBe(42);
    } finally {
      await session.dispose();
    }
  }, 40000);
});

describe.skipIf(!hasSwiftService)("MCP adapter: node_repl as an MCP server", () => {
  it("a client reaches computer.list_apps through MCP tools/list and tools/call js", async () => {
    const { server, dispose } = await buildNodeReplMcpServer({
      service: { socketPath: SOCK, autoStart: false }, // Reuse the Swift service from beforeAll.
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("js");

      const res = await client.callTool({
        name: "js",
        arguments: {
          source:
            'nodeRepl.setResponseMeta({"codex/toolSurface":{"kind":"computerUse"}});' +
            "return await computer.list_apps();",
        },
      });
      expect(JSON.stringify(res.content)).toMatch(/com\.|running/);
      expect(res._meta).toEqual({
        "codex/toolSurface": { app: null, kind: "computerUse" },
      });
    } finally {
      await client.close();
      await dispose();
    }
  }, 40000);

  it("returns a concise code and message without implementation stack frames", async () => {
    const { server, dispose } = await buildNodeReplMcpServer({
      service: { socketPath: SOCK, autoStart: false },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = await client.callTool({
        name: "js",
        arguments: {
          source:
            'const error = new Error("The user is still interacting. Wait 1 second and retry.");' +
            "error.code = -10016;" +
            "throw error;",
        },
      });

      expect(res.isError).toBe(true);
      expect(res.content).toEqual([
        {
          type: "text",
          text: "[-10016] The user is still interacting. Wait 1 second and retry.",
        },
      ]);
      expect(JSON.stringify(res.content)).not.toMatch(
        /node-repl\.js|packages\/computer-use|at process\./,
      );
    } finally {
      await client.close();
      await dispose();
    }
  }, 40000);
});

describe.skipIf(!hasSwiftService)("the synchronous MCP display stream: screenshots and text pushed mid-execution", () => {
  it("notifications/message pushes title, text and image live", async () => {
    const { server, dispose } = await buildNodeReplMcpServer({
      service: { socketPath: SOCK, autoStart: false },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0" }, { capabilities: {} });
    const notifs: Array<{ method: string; params: { data?: { type?: string; text?: string; mimeType?: string } } }> = [];
    client.fallbackNotificationHandler = async (n) => {
      notifs.push(n as (typeof notifs)[number]);
    };
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = await client.callTool({
        name: "js",
        arguments: {
          description: "demo step",
          source:
            'nodeRepl.write("hello\\n");' +
            'await nodeRepl.emitImage("data:image/png;base64,AA==");' +
            'await nodeRepl.emitImage({ image_url: "data:image/jpeg;base64,AQ==" });' +
            'await nodeRepl.emitImage(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));' +
            'await nodeRepl.emitImage({ bytes: Buffer.from([1,2]), mimeType: "image/webp" });' +
            'return "done";',
        },
      });
      const datas = notifs
        .filter((n) => n.method === "notifications/message")
        .map((n) => n.params.data ?? {});
      expect(datas.some((d) => d.type === "title" && d.text === "demo step")).toBe(true);
      expect(datas.some((d) => d.type === "text" && String(d.text).includes("hello"))).toBe(true);
      expect(datas.some((d) => d.type === "image" && d.mimeType === "image/png")).toBe(true);
      const images = res.content.filter((part) => part.type === "image");
      expect(images).toHaveLength(4);
      expect(images.map((image) => image.mimeType)).toEqual([
        "image/png",
        "image/jpeg",
        "image/png",
        "image/webp",
      ]);
      expect(JSON.stringify(res.content)).toContain("done");
    } finally {
      await client.close();
      await dispose();
    }
  }, 40000);
});

describe.skipIf(!hasSwiftService)("createComputerUse: the module's top-level API", () => {
  it("bootstraps in one line: manages its own Swift service, and the tool runs computer.list_apps", async () => {
    // Use its own socket, so it cannot clash with the shared service from beforeAll.
    const cu = await createComputerUse({
      service: { binaryPath: SWIFT_BIN, socketPath: "/tmp/opcu-factory.sock" },
    });
    try {
      const r = await cu.tool.execute({ code: "return await computer.list_apps();" });
      expect(JSON.stringify(r.result)).toMatch(/com\.|running/);
    } finally {
      await cu.dispose();
    }
  }, 40000);
});
