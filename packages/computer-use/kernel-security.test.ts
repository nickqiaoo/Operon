import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeReplSession } from "./NodeReplSession.ts";

/**
 * The kernel's two lines of defence.
 *
 * Background: to run a skill's bootstrap (`await import("<plugin>/browser-client.mjs")`)
 * the kernel has to permit dynamic import. But an imported module runs in the
 * kernel realm and can read the full `nodeRepl`, nativePipe included, off the
 * kernel's globalThis. Undefended, model code could write an `.mjs`, import it,
 * and obtain a direct connection to `/tmp/operon-browser-use/*.sock`, bypassing
 * every check the backend performs.
 *
 * The two defences:
 *
 *   1. Privilege separation: the two realms are injected with *different*
 *      nodeRepl objects. Model code gets the restricted one; trusted modules get
 *      the privileged one.
 *   defineLockedGlobal(trustedContext,   "process",  trustedProcess);
 *   const trustedNodeRepl = createPrivilegedNodeReplBridge({
 *     nativePipe: privilegedNativePipeBridge, authenticatedFetch, … })
 *
 *   2. The import allowlist.
 *   const trustedModuleSha256s      = parseTrustedModuleSha256s(process.env.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S);
 *   const additionalTrustedCodeDirs = (process.env.NODE_REPL_TRUSTED_CODE_PATHS || "").split(path.delimiter)…;
 *   const trustAllImportedCode      = process.env.NODE_REPL_TRUST_ALL_CODE === "1";
 */

const SOCK = "/tmp/opcu-security-unused.sock";

/** The allowlist reads the kernel *process* env, invisible to the model, so this
 *  goes through processEnv rather than env. */
async function run(code: string, processEnv?: Record<string, string>) {
  const s = new NodeReplSession({ socketPath: SOCK, processEnv });
  try {
    return await s.run(code, { session_id: "s", turn_id: "t" });
  } finally {
    await s.dispose();
  }
}

describe("defence 1: privilege separation, so model code cannot reach nativePipe", () => {
  it("the sandbox's nodeRepl has no nativePipe, which is the ability to reach a backend socket", async () => {
    const { result } = await run(`return typeof nodeRepl.nativePipe;`);
    expect(result).toBe("undefined");
  });

  it("the sandbox's nodeRepl has no launchServices, which would launch applications", async () => {
    const { result } = await run(`return typeof nodeRepl.launchServices;`);
    expect(result).toBe("undefined");
  });

  it("the unprivileged members still work: write, emitImage, createElicitation, requestMeta, tmpDir", async () => {
    const { result } = await run(`return [
      typeof nodeRepl.write, typeof nodeRepl.emitImage, typeof nodeRepl.createElicitation,
      typeof nodeRepl.setResponseMeta, typeof nodeRepl.requestMeta, typeof nodeRepl.tmpDir,
    ].join(",");`);
    expect(result).toBe("function,function,function,function,object,string");
  });

  it("model code cannot reach process: the untrusted context is never given one", async () => {
    const { result } = await run(`return typeof process;`);
    expect(result).toBe("undefined");
  });
});

describe("defence 2: the import allowlist", () => {
  it("only `node:` builtins are permitted by default", async () => {
    const { result } = await run(`const os = await import("node:os"); return typeof os.tmpdir;`);
    expect(result).toBe("function");
  });

  it("importing an arbitrary file from disk is refused by default, since it would bypass defence 1", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "untrusted-"));
    const file = path.join(dir, "evil.mjs");
    // Such a module would run in the kernel realm and read the full nodeRepl,
    // which is exactly what this refuses.
    await fs.promises.writeFile(file, `export const pipe = () => typeof globalThis.nodeRepl?.nativePipe;`);
    const { result } = await run(
      `try { await import(${JSON.stringify(file)}); return "IMPORTED"; }
       catch (e) { return "BLOCKED: " + e.message; }`,
    );
    expect(String(result)).toMatch(/BLOCKED: .*refusing to import untrusted module/);
  });

  it("a bare specifier is refused: it would pull arbitrary code out of node_modules", async () => {
    const { result } = await run(
      `try { await import("vitest"); return "IMPORTED"; } catch (e) { return "BLOCKED"; }`,
    );
    expect(result).toBe("BLOCKED");
  });

  it("a file under NODE_REPL_TRUSTED_CODE_PATHS is permitted", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "trusted-"));
    const file = path.join(dir, "ok.mjs");
    await fs.promises.writeFile(file, `export const hi = () => "trusted-ok";`);
    const { result } = await run(
      `const m = await import(${JSON.stringify(file)}); return m.hi();`,
      { NODE_REPL_TRUSTED_CODE_PATHS: dir },
    );
    expect(result).toBe("trusted-ok");
  });

  it("the Computer Use bootstrap can run repeatedly and reuses the same client", async () => {
    const clientPath = fileURLToPath(new URL("./runtime.ts", import.meta.url));
    const packageDir = path.dirname(clientPath);
    const session = new NodeReplSession({
      socketPath: SOCK,
      env: { OPERON_COMPUTER_USE_CLIENT_PATH: clientPath },
      processEnv: { NODE_REPL_TRUSTED_CODE_PATHS: packageDir },
    });
    const bootstrap = `
      if (!globalThis.computer) {
        const clientPath = nodeRepl.env?.OPERON_COMPUTER_USE_CLIENT_PATH;
        const { setupComputerUseRuntime } = await import(clientPath);
        await setupComputerUseRuntime({ globals: globalThis });
      }
    `;
    try {
      const first = await session.run(
        `delete globalThis.computer; ${bootstrap} globalThis.__firstClient = computer; return computer.target;`,
        { session_id: "s", turn_id: "t1" },
      );
      const second = await session.run(
        `${bootstrap} return globalThis.__firstClient === computer;`,
        { session_id: "s", turn_id: "t2" },
      );
      expect(first.result).toBe("mac");
      expect(second.result).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  it("a file whose sha256 is in NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S is permitted, which is how a browser client is trusted", async () => {
    const { createHash } = await import("node:crypto");
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sha-"));
    const file = path.join(dir, "client.mjs");
    const body = `export const hi = () => "sha-ok";`;
    await fs.promises.writeFile(file, body);
    const sha = createHash("sha256").update(body).digest("hex");
    const { result } = await run(
      `const m = await import(${JSON.stringify(file)}); return m.hi();`,
      { NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: `deadbeef,${sha}` },
    );
    expect(result).toBe("sha-ok");
  });

  it("one changed byte breaks the sha256 and the import is refused", async () => {
    const { createHash } = await import("node:crypto");
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sha2-"));
    const file = path.join(dir, "client.mjs");
    await fs.promises.writeFile(file, `export const hi = () => "v1";`);
    const sha = createHash("sha256").update(`export const hi = () => "v1";`).digest("hex");
    // The allowlist holds the old hash while the file has been swapped.
    await fs.promises.writeFile(file, `export const hi = () => "tampered";`);
    const { result } = await run(
      `try { await import(${JSON.stringify(file)}); return "IMPORTED"; } catch (e) { return "BLOCKED"; }`,
      { NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: sha },
    );
    expect(result).toBe("BLOCKED");
  });

  it("NODE_REPL_TRUST_ALL_CODE=1 permits everything, as an escape hatch", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "all-"));
    const file = path.join(dir, "any.mjs");
    await fs.promises.writeFile(file, `export const hi = () => "all-ok";`);
    const { result } = await run(
      `const m = await import(${JSON.stringify(file)}); return m.hi();`,
      { NODE_REPL_TRUST_ALL_CODE: "1" },
    );
    expect(result).toBe("all-ok");
  });
});
