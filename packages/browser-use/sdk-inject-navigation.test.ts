// @vitest-environment node
// Regression test: the injection caches must be cleared when a navigation
// replaces the document.
//
// Sequence under test: locator (injects the helper) -> goto/reload (new
// document, helper gone) -> locator again. Before the fix the caches still said
// "injected", `injectPlaywright` short-circuited, and every retry hit "injected
// helper is missing" until the timeout. In sdk-locator-real this only bit the
// two dialog tests, the sole place there that navigates after locator use.
//
// A separate file, deliberately with NO key events, NO clicks and NO dialogs:
// pure Runtime.evaluate, so the macOS headless key-wedge pathology (see
// docs/headless-key-wedge-repro.mjs) cannot interfere, and the run stays fast
// even on a machine where sdk-locator-real cascades into timeouts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { acquireChromeE2eLock, releaseChromeE2eLock } from "./chrome-e2e-lock.ts";
import { IabBackend, type CdpDriver } from "./IabBackend.ts";
import { BUILD_FLAVOR_ENV } from "./wire.ts";
import {
  BackendConnection,
  Tab as RawTab,
  connectPipe,
  setupBrowserRuntime,
  type Tab as SdkTab,
  type Browser as SdkBrowser,
} from "./sdk/index.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FLAVOR = "operon-inject-nav-repro";
const SESSION = "INJECT-NAV-REPRO";

describe.skipIf(!fs.existsSync(CHROME))("injection cache across navigation", () => {
  let chrome: ChildProcess;
  let userDir: string;
  let hidden: string;
  let backend: IabBackend;
  let ws: WebSocket;
  let tab: SdkTab;
  let rawConnection: BackendConnection;
  let pageUrl: string;
  let httpServer: import("node:http").Server;

  beforeAll(async () => {
    await acquireChromeE2eLock();

    userDir = fs.mkdtempSync(path.join(os.tmpdir(), "inj-chrome-"));
    chrome = spawn(CHROME, [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDir}`,
      "--no-first-run", "--no-default-browser-check", "about:blank",
    ], { stdio: "ignore" });

    let port = 0;
    const portFile = path.join(userDir, "DevToolsActivePort");
    for (let i = 0; i < 80 && !port; i++) {
      try { port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]) || 0; } catch { /* not yet */ }
      if (!port) await new Promise((r) => setTimeout(r, 120));
    }
    if (!port) throw new Error("headless Chrome did not start (no DevToolsActivePort)");

    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 80 && !target; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        target = list.find((t) => t.type === "page");
      } catch { /* not up yet */ }
      if (!target) await new Promise((r) => setTimeout(r, 120));
    }
    if (!target) throw new Error("headless Chrome did not start");

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("cannot connect to CDP")); });
    let cdpId = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const cdpEventSubs = new Set<(e: { source: { tabId: number }; method: string; params?: unknown }) => void>();
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; error?: unknown; result?: unknown; method?: string; params?: unknown };
      if (m.id == null) {
        if (m.method) for (const cb of cdpEventSubs) cb({ source: { tabId: 1 }, method: m.method, params: m.params });
        return;
      }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    };
    const cdp = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<unknown>((resolve, reject) => {
        const i = ++cdpId;
        pending.set(i, { resolve, reject });
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    const http = await import("node:http");
    httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><div id="log">ready</div></body></html>`);
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
    const addr = httpServer.address() as { port: number };
    pageUrl = `http://127.0.0.1:${addr.port}/`;

    const driver: CdpDriver = {
      onCdpEvent: (cb) => { cdpEventSubs.add(cb as never); return () => cdpEventSubs.delete(cb as never); },
      onDownloadChange: () => () => {},
      allowDownload: async () => {},
      attach: async () => {},
      detach: async () => {},
      listTabs: async () => [{ id: 1, title: "t", url: pageUrl, active: true }],
      createTab: async (url, owner) => ({ id: 1, title: "t", url: url ?? pageUrl, active: true, owner }) as never,
      closeTab: async () => {},
      sendCommand: async (_tabId, method, params, sessionId) =>
        (await cdp(method, (params ?? {}) as Record<string, unknown>, sessionId as string | undefined)) as never,
    };

    hidden = fs.mkdtempSync(path.join(os.tmpdir(), "inj-hidden-"));
    backend = new IabBackend({ driver, socketDir: hidden, buildFlavor: FLAVOR } as never);
    const sockPath = await backend.listen();

    (globalThis as Record<string, unknown>).nodeRepl = {
      nativePipe: {
        createConnection: (p: string) =>
          new Promise((res, rej) => {
            const s = net.createConnection(p);
            s.once("connect", () => res(s));
            s.once("error", rej);
          }),
      },
      requestMeta: { "x-codex-turn-metadata": { session_id: SESSION, turn_id: "T1" } },
      env: { [BUILD_FLAVOR_ENV]: FLAVOR },
      config: {
        readRequirements: async () => ({ requirements: { network: { enabled: true } } }),
        read: async () => ({}),
        readToml: async () => ({
          approval_mode: "never_ask",
          download_approval_mode: "never_ask",
          upload_approval_mode: "never_ask",
          history_approval_mode: "never_ask",
        }),
        writeToml: async () => {},
      },
      createElicitation: async () => ({ action: "accept" }),
    };

    const globals: Record<string, unknown> = {};
    await setupBrowserRuntime({ globals, socketDir: hidden });
    const agent = globals.agent as { browsers: { get(id: string): Promise<SdkBrowser> } };
    const browser = await agent.browsers.get("iab");
    const leasedTab = await browser.tabs.new();
    rawConnection = new BackendConnection(await connectPipe(sockPath));
    tab = new RawTab(rawConnection, Number(leasedTab.id));
    await tab.goto(pageUrl);
    await new Promise((r) => setTimeout(r, 500));
  }, 300_000);

  afterAll(async () => {
    try { ws?.close(); } catch { /* ignore */ }
    try { rawConnection?.close(); } catch { /* ignore */ }
    try { await backend?.close(); } catch { /* ignore */ }
    try { chrome?.kill("SIGKILL"); } catch { /* ignore */ }
    try { httpServer?.closeAllConnections(); } catch { /* ignore */ }
    try { await new Promise<void>((r) => httpServer?.close(() => r())); } catch { /* ignore */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(hidden, { recursive: true, force: true }); } catch { /* ignore */ }
    releaseChromeE2eLock();
  }, 30_000);

  it("locator works again after a goto invalidated the injected helper", async () => {
    // First use: injects the helper into the current document.
    expect(await tab.playwright.locator("#log").textContent({ timeout: 5000 })).toBe("ready");
    // Navigation: new document, helper gone.
    await tab.goto(pageUrl);
    await new Promise((r) => setTimeout(r, 500));
    // Second use: on HEAD the stale cache skips re-injection and this times out
    // with "injected helper is missing"; with the fix it re-injects and passes.
    expect(await tab.playwright.locator("#log").textContent({ timeout: 5000 })).toBe("ready");
  }, 60_000);

  it("locator works again after reload", async () => {
    await tab.reload();
    await new Promise((r) => setTimeout(r, 500));
    expect(await tab.playwright.locator("#log").textContent({ timeout: 5000 })).toBe("ready");
  }, 60_000);
});
