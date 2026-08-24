// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireChromeE2eLock, releaseChromeE2eLock } from "./chrome-e2e-lock.ts";
import { IabBackend, type CdpDriver } from "./IabBackend.ts";
import { BUILD_FLAVOR_ENV } from "./wire.ts";
import { NodeReplSession } from "@operon/computer-use";

/**
 * Switchover acceptance, exercising the full production path.
 *
 * Every other test imports the SDK directly inside the test process. This one
 * goes the way the product does:
 *
 *   NodeReplHost forks a kernel child process
 *     -> the kernel runs `await import(OPERON_BROWSER_CLIENT_PATH)` in the trusted realm
 *     -> the skill's bootstrap: setupBrowserRuntime({globals}), browsers.get("iab"), documentation()
 *     -> IabBackend -> CdpDriver -> a real Chrome
 *
 * This path reaches things nothing else can: the kernel's import allowlist (the
 * SDK directory not being trusted would block it), the vm sandbox's privilege
 * split (model code cannot reach nativePipe, so the SDK has to be imported into
 * the kernel realm), and whether tsx can load our .ts directly.
 */

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK_ENTRY = path.join(HERE, "sdk", "index.ts");
const FLAVOR = "operon-switchover";

describe.skipIf(!fs.existsSync(CHROME))("switchover: kernel to our SDK to a real Chrome", () => {
  let chrome: ChildProcess;
  let userDir: string;
  let hidden: string;
  let backend: IabBackend;
  let ws: WebSocket;
  let httpServer: http.Server;
  let session: NodeReplSession;
  let pageUrl: string;

  beforeAll(async () => {
    // Running several real-Chrome e2e files in parallel wedges the renderer
    // pipeline permanently; see chrome-e2e-lock.ts.
    await acquireChromeE2eLock();
    // Port 0 plus DevToolsActivePort, immune to colliding with a leaked Chrome.
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-chrome-"));
    chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let port = 0;
    const portFile = path.join(userDir, "DevToolsActivePort");
    for (let i = 0; i < 80 && !port; i++) {
      try {
        port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]) || 0;
      } catch { /* Not written yet. */ }
      if (!port) await new Promise((r) => setTimeout(r, 120));
    }
    if (!port) throw new Error("headless Chrome did not start (no DevToolsActivePort)");
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 80 && !target; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        target = list.find((t) => t.type === "page");
      } catch { /* Not up yet. */ }
      if (!target) await new Promise((r) => setTimeout(r, 120));
    }
    if (!target) throw new Error("headless Chrome did not start");

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("cannot connect to CDP")); });
    let cdpId = 0;
    const pending = new Map<number, (v: unknown) => void>();
    const evSubs = new Set<(e: { source: { tabId: number }; method: string; params?: unknown }) => void>();
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; method?: string; params?: unknown };
      if (m.id == null) {
        if (m.method) for (const cb of evSubs) cb({ source: { tabId: 1 }, method: m.method, params: m.params });
        return;
      }
      pending.get(m.id)?.(m.result);
      pending.delete(m.id);
    };
    const cdp = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<unknown>((resolve) => {
        const i = ++cdpId;
        pending.set(i, resolve);
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    httpServer = http.createServer((_q, r) => {
      r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      r.end(`<!doctype html><html><body><h1>Store</h1>
        <button id="buy">Buy now</button><div id="log"></div>
        <script>document.getElementById('buy').addEventListener('click',()=>{document.getElementById('log').textContent='bought'})</script>
      </body></html>`);
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
    pageUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}/`;

    const driver: CdpDriver = {
      onCdpEvent: (cb) => { evSubs.add(cb as never); return () => evSubs.delete(cb as never); },
      attach: async () => {},
      detach: async () => {},
      listTabs: async () => [{ id: 1, title: "t", url: pageUrl, active: true }],
      createTab: async (url, owner) => ({ id: 1, title: "t", url: url ?? pageUrl, active: true, owner }) as never,
      closeTab: async () => {},
      sendCommand: async (_t, m, p, sid) => (await cdp(m, (p ?? {}) as Record<string, unknown>, sid as string | undefined)) as never,
    };
    hidden = fs.mkdtempSync(path.join(os.tmpdir(), "sw-hidden-"));
    backend = new IabBackend({ driver, socketDir: hidden, buildFlavor: FLAVOR } as never);
    await backend.listen();

    // ---- A real kernel child process, configured the same way the production
    //      route does (see server/src/routes/node-repl-mcp.ts). ----
    session = new NodeReplSession({
      socketPath: path.join(hidden, "unused-cu.sock"),   // This test does not touch Computer Use.
      // `env` is nodeRepl.env, which the model can see.
      env: {
        OPERON_BROWSER_CLIENT_PATH: SDK_ENTRY,
        [BUILD_FLAVOR_ENV]: FLAVOR,
      },
      // `processEnv` is the kernel *process* env, which the import allowlist reads
      // and the model cannot see. Putting these in `env` instead leaves the
      // allowlist with no effect at all.
      processEnv: { NODE_REPL_TRUSTED_CODE_PATHS: HERE },
    });
    // The backend is hidden, so point the SDK's discovery at it.
    await session.run(`globalThis.__socketDir = ${JSON.stringify(hidden)}; "ok"`, { session_id: "SW", turn_id: "T1" });
  }, 300_000);  // Most of this is waiting on the chrome-e2e lock.

  afterAll(async () => {
    await session?.dispose?.();
    try { ws?.close(); } catch { /* ignore */ }
    await backend?.close?.();
    // Chrome first: it holds keep-alive connections to httpServer, and `close()` only calls
    // back once every connection is gone. Closing the server while the browser is still up
    // hangs here until vitest kills the hook.
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise<void>((r) => chrome.once("exit", () => r()));
      chrome.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    }
    httpServer?.closeAllConnections();
    await new Promise<void>((r) => httpServer?.close(() => r()));
    for (const d of [userDir, hidden]) if (d) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* The system reclaims tmp anyway. */ }
    releaseChromeE2eLock();
    // Killing a browser and reclaiming its profile does not fit in the default 10s hook budget
    // on a loaded CI runner.
  }, 30_000);

  const run = (code: string) => session.run(code, { session_id: "SW", turn_id: "T1" });

  it("the kernel can import our SDK: the trusted allowlist admits it", async () => {
    const r = await run(`
      const { setupBrowserRuntime } = await import(nodeRepl.env.OPERON_BROWSER_CLIENT_PATH);
      return typeof setupBrowserRuntime;`);
    expect(r.result, `kernel import failed: ${JSON.stringify(r)}`).toBe("function");
  }, 30_000);

  it("the skill bootstrap contract: setupBrowserRuntime, browsers.get('iab'), documentation()", async () => {
    const r = await run(`
      const { setupBrowserRuntime } = await import(nodeRepl.env.OPERON_BROWSER_CLIENT_PATH);
      await setupBrowserRuntime({ globals: globalThis, socketDir: globalThis.__socketDir });
      globalThis.iab = await agent.browsers.get("iab");
      const doc = await iab.documentation();
      return { browserId: typeof iab.browserId, docHead: doc.slice(0, 16), docLen: doc.length };`);
    expect(r.result).toMatchObject({ browserId: "string", docHead: "# Selected Brows" });
    expect((r.result as { docLen: number }).docLen).toBeGreaterThan(1000);
  }, 30_000);

  it("end to end: new tab, goto, domSnapshot, then a semantic click that really lands", async () => {
    const r = await run(`
      globalThis.tab = await iab.tabs.new();
      await tab.goto(${JSON.stringify(pageUrl)});
      const snap = await tab.playwright.domSnapshot();
      await tab.playwright.getByRole("button", { name: "Buy now" }).click({ timeout: 8000 });
      return {
        hasButton: snap.includes('button "Buy now"'),
        hasRawHtml: snap.includes("<html"),
        hasRef: snap.includes("[ref="),
        log: await tab.playwright.locator("#log").textContent({ timeout: 8000 })
      };`);
    expect(r.result).toMatchObject({
      hasButton: true,
      hasRawHtml: false,
      hasRef: false,
    });
    expect((r.result as { log?: string })?.log, "the click did not take effect").toBe("bought");
    expect(r.responseMeta["codex/browserUse"]).toBe(true);
    expect(r.responseMeta["codex/toolSurface"]).toMatchObject({
      backend: "iab",
      kind: "browserUse",
      openTabIds: ["1"],
      screenshot: {
        pageUrl: "http://127.0.0.1",
        tabId: "1",
      },
    });
  }, 60_000);

  /** The privilege split does not loosen just because the SDK became our own code. */
  it("model code in the vm sandbox still cannot reach nativePipe", async () => {
    const r = await run(`return typeof nodeRepl.nativePipe;`);
    expect(r.result, "nativePipe must not exist in the sandbox; the privilege split is broken").toBe("undefined");
  }, 20_000);
});
