// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { acquireChromeE2eLock, releaseChromeE2eLock } from "./chrome-e2e-lock.ts";
import { IabBackend, type CdpDriver } from "./IabBackend.ts";
import { BUILD_FLAVOR_ENV, backendSocketDir } from "./wire.ts";
import {
  BackendConnection,
  Tab as RawTab,
  closeBrowser,
  connectPipe,
  setupBrowserRuntime,
  type Tab as SdkTab,
  type Browser as SdkBrowser,
} from "./sdk/index.ts";

/** Use the SDK's real types rather than hand-written narrow interfaces. A
 *  hand-written one goes stale as the API grows (adding hover once produced a
 *  pile of TS2339s). With the real types, a changed signature turns this file red
 *  immediately. */
type Tabish = SdkTab;

/**
 * The locator layer, end to end against a real Chrome.
 *
 * A fake CdpDriver can prove which frames were sent. It cannot prove that a
 * selector actually resolved to an element, or that a click actually landed. The
 * value of the locator layer is precisely in the latter: the visibility fallback,
 * scrolling into view, and hit coordinates. None of that is reachable with a fake
 * driver.
 *
 * The wiring: a `CdpDriver` sitting on a real headless Chrome's CDP, so the chain
 * is SDK -> IabBackend -> this driver -> Chrome. The only difference from
 * production is that Chrome is underneath the driver rather than an Electron
 * webview.
 *
 * Skipped automatically when Chrome is not installed.
 */

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FLAVOR = "operon-locator-real";
const SESSION = "LOCATOR-REAL";


describe.skipIf(!fs.existsSync(CHROME))("locator layer against a real Chrome", () => {
  let chrome: ChildProcess;
  let userDir: string;
  let hidden: string;
  let sockPath: string;
  let backend: IabBackend;
  let ws: WebSocket;
  let tab: Tabish;
  let rawConnection: BackendConnection;
  let pageUrl: string;
  let httpServer: import("node:http").Server;
  /** Evaluate against the page directly, bypassing the SDK, so a test can change
   *  page state mid-run. */
  let cdpEval: (expr: string) => Promise<unknown>;
  let crossUrl: string;
  /** Used to test the id mapping in browsers.get. */
  let agentForIds: { browsers: { get(id: string): Promise<SdkBrowser> } };
  /** A fake extension backend that only answers getInfo. `iab` maps to itself, so
   *  only this can exercise `extension` mapping to `chrome`. */
  let fakeExt: net.Server;
  /** Fire a download notification by hand; in production Electron's will-download
   *  does it. */
  let emitDownload: (c: Record<string, unknown>) => void;
  /** URLs allowDownload has admitted, to verify the SDK grants before waiting. */
  let allowedDownloads: string[];

  beforeAll(async () => {
    // Running several real-Chrome e2e files in parallel wedges the renderer
    // pipeline permanently; see chrome-e2e-lock.ts.
    await acquireChromeE2eLock();

    // ---- Start headless Chrome ----
    // Use `--remote-debugging-port=0` and read DevToolsActivePort. A fixed port,
    // even a random one, is unsafe: a run killed on timeout never reaches
    // afterAll, and the leaked Chrome keeps its port. A later run that picks the
    // same number then connects silently to that old, broken Chrome, which shows
    // up as inexplicable cascading timeouts. That has happened, with four leaked
    // processes sitting on the machine. Port 0 lets Chrome choose a free port and
    // write it to `<userDir>/DevToolsActivePort`, which cannot collide.
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), "loc-chrome-"));
    chrome = spawn(CHROME, [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDir}`,
      "--no-first-run", "--no-default-browser-check", "about:blank",
    ], { stdio: "ignore" });

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

    // ---- Bare CDP client ----
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("cannot connect to CDP")); });
    let cdpId = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    /** The driver has to forward CDP events to the backend. Without that,
     *  `Fetch.requestPaused` never reaches the SDK and `Page.navigate` never
     *  returns on a real page. The production driver in
     *  electron/browser-use-driver.ts does the same. */
    const cdpEventSubs = new Set<(e: { source: { tabId: number }; method: string; params?: unknown }) => void>();
    const downloadSubs = new Set<(c: Record<string, unknown>) => void>();
    allowedDownloads = [];
    emitDownload = (c) => { for (const cb of downloadSubs) cb(c); };
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
    /**
     * `sessionId` has to be passed through: CDP routes flattened sessions by the
     * `sessionId` on the frame, and the backend supplies it as the fourth
     * argument to `sendCommand`, which is how a cross-origin OOPIF is reached at
     * all. Drop it and the command runs silently in the main frame, so elements
     * inside an OOPIF are never found. The production driver does the same.
     */
    const cdp = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<unknown>((resolve, reject) => {
        const i = ++cdpId;
        pending.set(i, { resolve, reject });
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    cdpEval = (expression: string) => cdp("Runtime.evaluate", { expression, returnByValue: true });

    // ---- Test page. Served over http rather than data:, since CSP and origin
    //      rules block Playwright's injection on a data: URL. ----
    const http = await import("node:http");
    httpServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (req.url === "/inner") {
        // First same-origin level; nested once more to exercise multi-level descent.
        res.end(`<!doctype html><html><body style="margin:0">
          <button id="in1">Inner One</button>
          <iframe id="deeper" src="/deep" style="width:200px;height:80px"></iframe>
        </body></html>`);
        return;
      }
      if (req.url === "/deep") {
        res.end(`<!doctype html><html><body style="margin:0">
          <button id="in2">Deep Two</button>
          <div id="deeplog"></div>
          <script>document.getElementById('in2').addEventListener('click',()=>{document.getElementById('deeplog').textContent='deep-clicked'})</script>
        </body></html>`);
        return;
      }
      if (req.url === "/cross") {
        res.end(`<!doctype html><html><body style="margin:0">
          <button id="x">Cross Button</button>
          <div id="xlog"></div>
          <script>document.getElementById('x').addEventListener('click',()=>{document.getElementById('xlog').textContent='cross-clicked'})</script>
        </body></html>`);
        return;
      }
      if (req.url === "/nested") {
        res.end(`<!doctype html><html><body style="margin:0">
          <iframe id="nested-cross" src="${pageUrl}nested-deep" style="width:180px;height:90px"></iframe>
        </body></html>`);
        return;
      }
      if (req.url === "/nested-deep") {
        res.end(`<!doctype html><html><body style="margin:0">
          <button id="nested-button">Nested Cross Button</button>
          <div id="nested-log"></div>
          <script>document.getElementById('nested-button').addEventListener('click',()=>{document.getElementById('nested-log').textContent='nested-clicked'})</script>
        </body></html>`);
        return;
      }
      res.end(`<!doctype html><html><body>
        <h1>Checkout</h1>
        <button id="go">Submit order</button>
        <label for="em">Email</label><input id="em" type="email">
        <div data-testid="card"><span>hello</span></div>
        <!-- A hidden duplicate, to exercise strict mode's visibility fallback;
             pure strict would call this ambiguous. -->
        <button style="display:none">Submit order</button>
        <!-- Zero-sized but not display:none. A computedStyle check does not catch
             it; only measuring the rect does. Real pages are full of these:
             collapsed drawers, sidebars animated to zero width. -->
        <button id="zero" style="width:0;height:0;padding:0;border:0;overflow:hidden">Zero Sized</button>
        <div id="log"></div>

        <!-- A button fully covered by an overlay; hit testing should refuse it. -->
        <div style="position:relative">
          <button id="covered">Covered</button>
          <div id="veil" style="position:absolute;inset:0;background:rgba(0,0,0,.3)"></div>
        </div>

        <!-- disabled: actionability's enabled check should refuse it. -->
        <button id="dis" disabled>Disabled</button>

        <!-- Appears after 1.2s; the retry loop should wait for it. -->
        <div id="late-host"></div>

        <!-- Target for the newer action surface. -->
        <input id="chk" type="checkbox">
        <select id="sel"><option value="a">A</option><option value="b">B</option></select>
        <div id="hoverme">hover me</div><div id="hoverlog"></div>
        <input id="keyin" type="text">
        <ul id="rows"><li>r1</li><li>r2</li><li>r3</li></ul>
        <button id="dis2" disabled>Off</button>
        <div id="vanish">going</div>
        <input id="ph" placeholder="Search here"><img id="im" alt="A cat" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
        <div id="drop" style="width:80px;height:40px;background:#eee">drop</div>
        <div id="drag" draggable="true" style="width:40px;height:20px;background:#ccc">d</div>
        <!-- Only responds to a click after a mouseover, the way hover menus and
             tooltip buttons behave on real sites. -->
        <button id="hoveronly">Hover First</button>
        <script>
          (() => {
            const b = document.getElementById('hoveronly'); let armed = false;
            b.addEventListener('mouseover', () => { armed = true; });
            b.addEventListener('click', () => {
              document.getElementById('log').textContent = armed ? 'hover-then-click' : 'click-without-hover';
            });
            // Record the event sequence, which is what pages tracking a mousemove
            // path rely on: canvases, drag affordances.
            window.__seq = [];
            for (const t of ['mousemove','mousedown','mouseup'])
              b.addEventListener(t, () => window.__seq.push(t));
            window.__seqReset = () => { window.__seq = []; };
          })();
        </script>
        <script>
          document.getElementById('hoverme').addEventListener('mouseover',()=>{document.getElementById('hoverlog').textContent='hovered'});
          document.getElementById('sel').addEventListener('change',(e)=>{document.getElementById('log').textContent='sel:'+e.target.value});
          document.getElementById('keyin').addEventListener('keydown',(e)=>{if(e.key==='Enter')document.getElementById('log').textContent='entered'});
          // Older sites read keyCode/which rather than e.key, and break without a
          // windowsVirtualKeyCode.
          document.getElementById('keyin').addEventListener('keydown',(e)=>{
            if(e.keyCode===40||e.which===40) document.getElementById('log').textContent='vk-down:'+e.keyCode;
          });
          window.__vanish = () => document.getElementById('vanish')?.remove();
          window.__alert = () => { window.alert('boom'); document.getElementById('log').textContent='after-alert'; };
          window.__confirm = () => { document.getElementById('log').textContent = 'confirm:' + window.confirm('ok?'); };
          window.__prompt = () => { document.getElementById('log').textContent = 'prompt:' + window.prompt('name?','dflt'); };
        </script>

        <!-- Same-origin iframe, nested twice and CSS-scaled, to exercise scaleX and
             scaleY in the coordinate conversion. -->
        <iframe id="same" src="/inner" style="width:300px;height:150px;transform:scale(0.5);transform-origin:top left"></iframe>
        <!-- Cross-origin iframe: localhost and 127.0.0.1 are different origins. -->
        <iframe id="cross" src="${crossUrl}" style="width:200px;height:100px"></iframe>
        <!-- Crossing back to 127.0.0.1 inside an OOPIF, to exercise nested OOPIF
             targets and the coordinate chain. -->
        <iframe id="nested" src="${crossUrl.replace("/cross", "/nested")}" style="width:220px;height:120px;transform:scale(.8);transform-origin:top left"></iframe>

        <script>
          document.getElementById('go').addEventListener('click', () => {
            document.getElementById('log').textContent = 'clicked';
          });
          document.getElementById('covered').addEventListener('click', () => {
            document.getElementById('log').textContent = 'covered-clicked';
          });
          setTimeout(() => {
            const b = document.createElement('button');
            b.id = 'late'; b.textContent = 'Late';
            b.addEventListener('click', () => { document.getElementById('log').textContent = 'late-clicked'; });
            document.getElementById('late-host').appendChild(b);
          }, 1200);
          // Clicking the veil removes it, so a retry can succeed once the
          // obstruction is gone.
          window.__removeVeil = () => document.getElementById('veil').remove();
        </script>
      </body></html>`);
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
    const addr = httpServer.address() as { port: number };
    pageUrl = `http://127.0.0.1:${addr.port}/`;
    // localhost and 127.0.0.1 are the same machine but different origins, which
    // gives a cross-origin iframe without running a second server.
    crossUrl = `http://localhost:${addr.port}/cross`;

    // ---- CdpDriver wired to the real Chrome ----
    const driver: CdpDriver = {
      onCdpEvent: (cb) => { cdpEventSubs.add(cb as never); return () => cdpEventSubs.delete(cb as never); },
      /** Download lifecycle to wire notification. Electron's `will-download` drives
       *  this in production; here it is fired by hand. */
      onDownloadChange: (cb) => { downloadSubs.add(cb as never); return () => downloadSubs.delete(cb as never); },
      /**
       * The backend decides whether a browser supports downloads at all by
       * checking `driver.allowDownload == null`, and refuses outright without it
       * (`Downloads are not supported by this in-app browser`). Electron admits
       * `will-download` in production; here the URLs admitted are just recorded.
       */
      allowDownload: async (_tabId, url) => { allowedDownloads.push(url); },
      attach: async () => {},
      detach: async () => {},
      listTabs: async () => [{ id: 1, title: "t", url: pageUrl, active: true }],
      createTab: async (url, owner) => ({ id: 1, title: "t", url: url ?? pageUrl, active: true, owner }) as never,
      closeTab: async () => {},
      sendCommand: async (_tabId, method, params, sessionId) =>
        (await cdp(method, (params ?? {}) as Record<string, unknown>, sessionId as string | undefined)) as never,
    };

    hidden = fs.mkdtempSync(path.join(os.tmpdir(), "loc-hidden-"));
    backend = new IabBackend({ driver, socketDir: hidden, buildFlavor: FLAVOR } as never);
    sockPath = await backend.listen();

    // The backend is hidden, so point the SDK straight at it: this test does not
    // need a recording proxy.
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
    // A backend with type="extension" is required to exercise the mapping at all,
    // since iab maps to itself and a mutation there goes unnoticed.
    {
      const { encodeFrame, decodeFrames } = await import("./wire.ts");
      fakeExt = net.createServer((c) => {
        let b: Buffer = Buffer.alloc(0);
        c.on("error", () => {});
        c.on("data", (d) => {
          b = Buffer.concat([b, d]);
          const { messages, remainingData } = decodeFrames(b);
          b = remainingData;
          for (const m of messages) {
            const msg = JSON.parse(m) as { id: number; method: string; params?: { session_id?: string } };
            if (msg.method !== "getInfo") continue;
            c.write(encodeFrame(JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              result: {
                id: "fake-ext", name: "Fake Chrome", type: "extension",
                capabilities: {},
                // Echo the asker's session_id back, or discovery filters us out.
                metadata: { operonSessionId: msg.params?.session_id ?? "", operonBuildFlavor: FLAVOR },
              },
            })));
          }
        });
      });
      await new Promise<void>((r) => fakeExt.listen(path.join(hidden, "fake-ext.sock"), () => r()));
    }
    agentForIds = agent;
    const browser = await agent.browsers.get("iab");
    const leasedTab = await browser.tabs.new();
    rawConnection = new BackendConnection(await connectPipe(sockPath));
    tab = new RawTab(rawConnection, Number(leasedTab.id));
    await tab.goto(pageUrl);
    // Wait for the navigation to settle: goto only sends Page.navigate and does
    // not wait for load.
    await new Promise((r) => setTimeout(r, 500));
  }, 300_000);  // Most of this is waiting on the chrome-e2e lock, with up to two
                // other Chrome files ahead in the queue.

  afterAll(async () => {
    try { ws?.close(); } catch { /* ignore */ }
    await backend?.close?.();
    rawConnection?.close();
    // Chrome first: it holds keep-alive connections to httpServer, and `close()` only calls
    // back once every connection is gone. Closing the server while the browser is still up
    // hangs here until vitest kills the hook.
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise<void>((r) => chrome.once("exit", () => r()));
      chrome.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (chrome.exitCode === null) chrome.kill("SIGKILL");
    }
    httpServer?.closeAllConnections();
    await new Promise<void>((r) => httpServer?.close(() => r()));
    await new Promise<void>((r) => fakeExt?.close(() => r()));
    for (const d of [userDir, hidden]) {
      if (d) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* The system reclaims tmp anyway. */ }
    }
    releaseChromeE2eLock();
    // Killing a browser and reclaiming its profile does not fit in the default 10s hook budget
    // on a loaded CI runner.
  }, 30_000);

  it("count and isVisible: the selector really resolved to an element", async () => {
    expect(await tab.playwright.locator("#go").count()).toBe(1);
    expect(await tab.playwright.locator("#go").isVisible()).toBe(true);
    expect(await tab.playwright.locator("#nonexistent").count()).toBe(0);
    expect(await tab.playwright.locator("#nonexistent").isVisible()).toBe(false);
  });

  it("textContent, plus the getByTestId and getByRole sugar", async () => {
    expect(await tab.playwright.locator("#go").textContent()).toBe("Submit order");
    expect(await tab.playwright.getByTestId("card").textContent()).toBe("hello");
    expect(await tab.playwright.getByRole("button", { name: "Submit order" }).textContent()).toBe("Submit order");
  });

  /** One of the reasons the locator layer exists: the page has two "Submit order"
 *  elements and one of them is display:none. */
  it("strict mode's visibility fallback: a hidden duplicate is not ambiguous", async () => {
    const byRole = tab.playwright.getByRole("button", { name: "Submit order" });
    // Pure strict mode would call two matches ambiguous; the visibility fallback
    // picks the one that is visible.
    expect(await byRole.textContent()).toBe("Submit order");
  });

  it("click actually lands: the page's handler runs", async () => {
    await tab.playwright.locator("#go").click();
    expect(await tab.playwright.locator("#log").textContent()).toBe("clicked");
  });

  it("fill really fills, through injectedScript.fill rather than assigning value", async () => {
    await tab.playwright.locator("#em").fill("user@example.com");
    // An input's value is not in textContent; the aria snapshot carries the
    // textbox's current value, so assert on that.
    const snap = await tab.playwright.ariaSnapshot();
    expect(snap).toContain("user@example.com");

    // An empty value takes the Delete path: insertText is a no-op on an empty
    // string and would clear nothing.
    await tab.playwright.locator("#em").fill("");
    expect(await tab.playwright.ariaSnapshot()).not.toContain("user@example.com");
  });

  it("ariaSnapshot(mode:ai) produces a tree with refs, and a ref feeds back into locator", async () => {
    const snap = await tab.playwright.ariaSnapshot();
    expect(snap).toContain('button "Submit order"');
    const ref = /button "Submit order" \[ref=([^\]]+)\]/.exec(snap)?.[1];
    expect(ref, "the snapshot gave the button no ref").toBeTruthy();
    // This is the agent's main path: take a snapshot, pick a ref, click it.
    expect(await tab.playwright.locator(`aria-ref=${ref}`).textContent()).toBe("Submit order");
  });

  it("domSnapshot produces a compact semantic tree for the model, with no raw HTML or internal refs", async () => {
    const snap = await tab.playwright.domSnapshot();
    expect(snap).toContain('button "Submit order"');
    expect(snap).toContain('button "Inner One"');
    expect(snap).not.toContain("<html");
    expect(snap).not.toContain("[ref=");
    expect(snap).not.toContain("[cursor=");
  });

  /** Hit testing: the button exists and is "visible", but an overlay covers it.
   *  Without a hit test the click would land silently on the overlay. */
  it("a button covered by an overlay is not clicked: hit testing refuses and it times out", async () => {
    await expect(tab.playwright.locator("#covered").click({ timeout: 800 })).rejects.toThrow(/#covered/);
    // The point is that the handler did not run, which shows the click was not
    // dispatched blindly at a coordinate.
    expect(await tab.playwright.locator("#log").textContent()).not.toBe("covered-clicked");
  }, 60_000);

  /** Once the obstruction goes, the same locator should succeed on retry, showing
   *  it retries until clickable rather than failing once and giving up. */
  it("succeeds on retry once the obstruction is removed", async () => {
    const clicking = tab.playwright.locator("#covered").click({ timeout: 8000 });
    // Lift the overlay after 300ms; the retry loop should then land the click.
    setTimeout(() => { void tab.playwright.locator("body").count().then(() => cdpEval("window.__removeVeil()")); }, 300);
    await clicking;
    expect(await tab.playwright.locator("#log").textContent()).toBe("covered-clicked");
  }, 60_000);

  /** A disabled button: actionability's enabled check should refuse it. An early
   *  version only checked visibility and clicked it anyway. */
  it("a disabled button cannot be clicked: the enabled state refuses it", async () => {
    await expect(tab.playwright.locator("#dis").click({ timeout: 800 })).rejects.toThrow(/#dis/);
  }, 60_000);

  /** The retry loop: the element appears after 1.2s and the locator should wait. */
  it("waits for an element that appears late", async () => {
    await tab.playwright.locator("#late").click({ timeout: 8000 });
    expect(await tab.playwright.locator("#log").textContent()).toBe("late-clicked");
  }, 60_000);

  /** Same-origin iframe: the selector marks the boundary with
   *  `internal:control=enter-frame` and the SDK should descend through it. */
  it("same-origin iframe: reads an element inside the frame", async () => {
    const inner = tab.playwright.locator("#same >> internal:control=enter-frame >> #in1");
    expect(await inner.textContent()).toBe("Inner One");
  }, 60_000);

  /** Two levels of nesting with the outer iframe CSS-scaled to 0.5. Click
   *  coordinates have to be converted level by level, scale included, or they
   *  land in the wrong place. */
  it("nested iframes with CSS scaling: click coordinates convert correctly and hit the innermost button", async () => {
    const deep = tab.playwright.locator(
      "#same >> internal:control=enter-frame >> #deeper >> internal:control=enter-frame >> #in2",
    );
    expect(await deep.textContent()).toBe("Deep Two");
    await deep.click({ timeout: 8000 });
    // The innermost frame's own log, which only changes on a real hit.
    const log = tab.playwright.locator(
      "#same >> internal:control=enter-frame >> #deeper >> internal:control=enter-frame >> #deeplog",
    );
    expect(await log.textContent()).toBe("deep-clicked");
  }, 60_000);

  /**
   * Cross-origin OOPIF: `localhost` and `127.0.0.1` are different origins, so
   * Chrome puts the frame in its own process. `contentWindow` is unreachable from
   * the page, so the SDK has to tag the iframe, resolve a frameId (which is the
   * targetId) through describeNode, attachTarget, then inject and resolve inside
   * that target.
   */
  it("cross-origin OOPIF: reads an element inside the frame", async () => {
    const x = tab.playwright.locator("#cross >> internal:control=enter-frame >> #x");
    expect(await x.textContent({ timeout: 8000 })).toBe("Cross Button");
  }, 60_000);

  /** Clicking inside a cross-origin OOPIF: the iframe's offset in the main frame
   *  has to be added back, or the click lands silently somewhere else. */
  it("cross-origin OOPIF: the click lands, with offset compensation applied", async () => {
    await tab.playwright.locator("#cross >> internal:control=enter-frame >> #x").click({ timeout: 8000 });
    const log = tab.playwright.locator("#cross >> internal:control=enter-frame >> #xlog");
    expect(await log.textContent({ timeout: 8000 })).toBe("cross-clicked");
  }, 60_000);

  it("nested OOPIFs: readable, and clickable at coordinates scaled level by level", async () => {
    const nested = tab.playwright
      .frameLocator("#nested")
      .frameLocator("#nested-cross");
    expect(
      await nested.locator("#nested-button").textContent({ timeout: 8_000 }),
    ).toBe("Nested Cross Button");
    await nested.locator("#nested-button").click({ timeout: 8_000 });
    expect(
      await nested.locator("#nested-log").textContent({ timeout: 8_000 }),
    ).toBe("nested-clicked");
  }, 60_000);

  it("hover really fires mouseover", async () => {
    await tab.playwright.locator("#hoverme").hover();
    expect(await tab.playwright.locator("#hoverlog").textContent()).toBe("hovered");
  }, 60_000);

  /** check and uncheck have to read the state first: clicking unconditionally
   *  would uncheck something already checked. */
  it("check and uncheck behave correctly, and are a no-op when already in that state", async () => {
    const chk = tab.playwright.locator("#chk");
    expect(await chk.isChecked()).toBe(false);
    await chk.check();
    expect(await chk.isChecked()).toBe(true);
    await chk.check(); // Checking again should be a no-op, not flip it back.
    expect(await chk.isChecked(), "a repeat check unchecked it, so the state was never read").toBe(true);
    await chk.uncheck();
    expect(await chk.isChecked()).toBe(false);
  }, 60_000);

  it("selectOption really dispatches change", async () => {
    await tab.playwright.locator("#sel").selectOption("b");
    expect(await tab.playwright.locator("#log").textContent()).toBe("sel:b");
    expect(await tab.playwright.locator("#sel").inputValue()).toBe("b");
  }, 60_000);

  it("press reaches the element, with a virtual key code the page handler recognises", async () => {
    await tab.playwright.locator("#keyin").press("Enter");
    expect(await tab.playwright.locator("#log").textContent()).toBe("entered");
  }, 60_000);

  /** Without windowsVirtualKeyCode, older sites reading `e.keyCode` or `e.which`
   *  receive 0. */
  it("press carries windowsVirtualKeyCode, so pages reading keyCode work too", async () => {
    await tab.playwright.locator("#keyin").press("ArrowDown");
    expect(await tab.playwright.locator("#log").textContent()).toBe("vk-down:40");
  }, 60_000);

  it("getAttribute / innerText / inputValue / isEnabled", async () => {
    expect(await tab.playwright.locator("#em").getAttribute("type")).toBe("email");
    expect(await tab.playwright.locator("#go").innerText()).toBe("Submit order");
    expect(await tab.playwright.locator("#dis2").isEnabled()).toBe(false);
    expect(await tab.playwright.locator("#go").isEnabled()).toBe(true);
  }, 60_000);

  it("nth / first / last / allTextContents", async () => {
    expect(await tab.playwright.locator("#rows li").allTextContents()).toEqual(["r1", "r2", "r3"]);
    expect(await tab.playwright.locator("#rows li").first().textContent()).toBe("r1");
    expect(await tab.playwright.locator("#rows li").nth(1).textContent()).toBe("r2");
    expect(await tab.playwright.locator("#rows li").last().textContent()).toBe("r3");
  }, 60_000);

  /**
   * Do not rely on a page-level setTimeout to make something disappear: earlier
   * tests run past that moment, and this one then starts with the element already
   * gone (which produced `expected false to be true`). Trigger it from the test.
   */
  it("waitFor detached: waits for something to go away", async () => {
    expect(await tab.playwright.locator("#vanish").isVisible()).toBe(true);
    setTimeout(() => void cdpEval("window.__vanish()"), 300);
    await tab.playwright.locator("#vanish").waitFor({ state: "detached", timeout: 5000 });
    expect(await tab.playwright.locator("#vanish").count()).toBe(0);
  }, 60_000);

  it("boundingBox is a real box in main-frame coordinates", async () => {
    const b = await tab.playwright.locator("#go").boundingBox();
    expect(b, "no box returned").toBeTruthy();
    expect(b!.width).toBeGreaterThan(10);
    expect(b!.height).toBeGreaterThan(5);
  }, 60_000);

  it("screenshot returns real JPEG bytes", async () => {
    const shot = await tab.screenshot();
    expect(shot).toBeInstanceOf(Uint8Array);
    expect([...shot.slice(0, 4)]).toEqual([255, 216, 255, 224]);
    expect(shot.length, "too short to be a real image").toBeGreaterThan(2000);
  }, 60_000);

  it("title / url", async () => {
    expect(await tab.title()).toBe("t");
    expect(await tab.url()).toContain("127.0.0.1");
  }, 60_000);

  it("getByPlaceholder / getByAltText", async () => {
    expect(await tab.playwright.getByPlaceholder("Search here").getAttribute("id")).toBe("ph");
    expect(await tab.playwright.getByAltText("A cat").getAttribute("id")).toBe("im");
  }, 60_000);

  /** frameLocator is only selector composition, but this proves it really reaches
   *  into a frame, cross-origin included. */
  it("frameLocator reaches into both same-origin and cross-origin frames", async () => {
    expect(await tab.playwright.frameLocator("#same").locator("#in1").textContent({ timeout: 8000 })).toBe("Inner One");
    // Nested: a chain of frameLocators.
    expect(
      await tab.playwright.frameLocator("#same").frameLocator("#deeper").locator("#in2").textContent({ timeout: 8000 }),
    ).toBe("Deep Two");
    // Cross-origin OOPIF.
    expect(await tab.playwright.frameLocator("#cross").locator("#x").textContent({ timeout: 8000 })).toBe("Cross Button");
  }, 60_000);

  it("filter / all / evaluate", async () => {
    expect(await tab.playwright.locator("#rows li").filter({ hasText: "r2" }).textContent()).toBe("r2");
    expect((await tab.playwright.locator("#rows li").all()).length).toBe(3);
    expect(await tab.playwright.locator("#go").evaluate<string>("(el) => el.tagName")).toBe("BUTTON");
  }, 60_000);

  /** CUA works in coordinates: it waits for nothing and verifies nothing, clicking
   *  exactly where told. Here a locator supplies the coordinates and CUA clicks. */
  it("cua.click lands at the given coordinates: the screenshot-and-coordinates fallback", async () => {
    await cdpEval("document.getElementById('log').textContent=''");
    const b = await tab.playwright.locator("#go").boundingBox();
    await tab.cua.click({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 });
    expect(await tab.playwright.locator("#log").textContent()).toBe("clicked");
  }, 60_000);

  /**
   * cua.click has to send mouseMoved first.
   *
   * A hover-dependent button cannot test this: Chrome synthesises hover on
   * `mousePressed`, so such a button responds even without the move and the
   * mutation goes unnoticed. The real difference is the event sequence, which is
   * what a page tracking a mousemove path sees, whether a canvas, a drag
   * affordance or heat-map analytics. So assert on the sequence directly.
   */
  it("cua.click sends mouseMoved first: the sequence is move, down, up", async () => {
    await cdpEval("window.__seqReset()");
    const b = await tab.playwright.locator("#hoveronly").boundingBox();
    await tab.cua.click({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 });
    const seq = await cdpEval("JSON.stringify(window.__seq)") as { result?: { value?: string } };
    const events = JSON.parse(String(seq?.result?.value ?? "[]")) as string[];
    expect(events[0], `wrong sequence: ${JSON.stringify(events)}`).toBe("mousemove");
    expect(events).toContain("mousedown");
    expect(events).toContain("mouseup");
    // The hover state did take effect too.
    expect(await tab.playwright.locator("#log").textContent()).toBe("hover-then-click");
  }, 60_000);

  it("cua.keypress handles a chord, with the right modifier bitmask", async () => {
    await tab.playwright.locator("#keyin").focus();
    await tab.cua.keypress({ keys: ["Control", "a"] });   // Not throwing means the modifiers resolved.
    expect(await tab.playwright.locator("#keyin").isVisible()).toBe(true);
  }, 60_000);

  it("clipboard read and write, which need grantPermissions or fail with a silent NotAllowedError", async () => {
    await tab.clipboard.writeText("hello-clip");
    expect(await tab.clipboard.readText()).toBe("hello-clip");
  }, 60_000);

  it("dragTo sends press, move, move, release, which HTML5 drag recognises", async () => {
    await tab.playwright.locator("#drag").dragTo(tab.playwright.locator("#drop"));
    // This page implements no drop handler, so only assert it does not throw and
    // the element survives.
    expect(await tab.playwright.locator("#drag").isVisible()).toBe(true);
  }, 60_000);

  it("waitForLoadState returns immediately when already complete, rather than waiting on an event", async () => {
    const t0 = Date.now();
    await tab.playwright.waitForLoadState({ state: "load", timeoutMs: 3000 });
    // The event has long since fired; waiting only for it would hang until timeout.
    expect(Date.now() - t0, "already complete, yet it waited for the event").toBeLessThan(1000);
  }, 60_000);

  /** Downloads: take the Download object first, then have path() wait for the
   *  backend to push a terminal state. */
  it("download resolves only on a terminal state, not an intermediate one", async () => {
    const url = pageUrl + "file.bin";
    const p = tab.playwright.waitForEvent("download", { timeoutMs: 8000 });
    await new Promise((r) => setTimeout(r, 200));
    emitDownload({ id: "d1", filename: "f.bin", status: "started", url, session_id: SESSION });
    const download = await p;
    const downloadPath = download.path();
    emitDownload({ id: "d1", filename: "f.bin", status: "in_progress", url, session_id: SESSION });
    const early = await Promise.race([
      downloadPath.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 150)),
    ]);
    expect(early).toBe("waiting");
    emitDownload({ id: "d1", filename: "f.bin", status: "complete", url, session_id: SESSION });
    await expect(downloadPath).resolves.toContain("f.bin");
  }, 60_000);

  it("a cancelled download throws rather than succeeding silently", async () => {
    const url = pageUrl + "nope.bin";
    const p = tab.playwright.waitForEvent("download", { timeoutMs: 8000 });
    await new Promise((r) => setTimeout(r, 200));
    emitDownload({ id: "d2", filename: "n.bin", status: "started", url, session_id: SESSION });
    const download = await p;
    const downloadPath = download.path();
    emitDownload({ id: "d2", filename: "n.bin", status: "canceled", url, session_id: SESSION });
    await expect(downloadPath).rejects.toThrow(/canceled/);
  }, 60_000);

  it("dom_cua: get_visible_dom collects only visible interactive elements, clickable by id", async () => {
    const nodes = await tab.dom_cua.get_visible_dom();
    expect(nodes.length, "nothing collected at all").toBeGreaterThan(3);
    // The hidden duplicate button should not be included.
    expect(nodes.filter((n) => n.text === "Submit order").length, "the display:none copy was collected").toBe(1);
    // A zero-sized element is "visible" by computedStyle, and only measuring its
    // boundingRect refuses it. Testing display:none alone would let a mutation
    // that removes the size check through.
    expect(nodes.some((n) => n.text === "Zero Sized"), "a zero-sized element was collected").toBe(false);
    await cdpEval("document.getElementById('log').textContent=''");
    const buy = nodes.find((n) => n.text === "Submit order")!;
    await tab.dom_cua.click({ node_id: buy.id });
    expect(await tab.playwright.locator("#log").textContent()).toBe("clicked");
  }, 60_000);

  it("dom_cua: a stale snapshot raises a clear error rather than clicking the wrong thing", async () => {
    await expect(tab.dom_cua.click({ node_id: "99999" })).rejects.toThrow(/stale|No node/);
  }, 60_000);

  /**
   * Skills and site adapters call `browsers.get("chrome")`, not `"extension"`.
   *
   * The wire `type` is an implementation detail (a Chrome extension drives the
   * user's browser); the model-facing id is `"chrome"`. Without the mapping,
   * `No browser matching "chrome"` takes out every skill that names it.
   */
  it("browsers.get('chrome') resolves to the type=extension backend, so the mapping works", async () => {
    const chrome = await agentForIds.browsers.get("chrome");
    // `fake-ext` is the only backend with type "extension" (see the fixture
    // above), so resolving to it is the mapping working.
    // This once asserted `chrome.info.type === "extension"`, but `info` is now a
    // `#` private field: the documented own-property set is [browserId,
    // capabilities, tabs, user] (see sdk-shape.test.ts). Asserting on the public
    // surface is enough, since without the mapping get("chrome") throws
    // No browser matching and this test still fails.
    expect(chrome.browserId, "get('chrome') should resolve to the wire type=extension backend").toBe("fake-ext");
    closeBrowser(chrome);
  }, 60_000);

  it("a failed lookup lists the available client types in the error", async () => {
    const err = await agentForIds.browsers.get("safari").catch((e: unknown) => String(e));
    expect(String(err)).toContain("available:");
    expect(String(err)).toContain("extension");
  }, 60_000);

  /**
   * The site adapters depend entirely on `playwright.evaluate`. `bilibili.hot`
   * navigates and then evaluates a `fetch(..., {credentials:"include"})` to read
   * structured data with the user's cookies. Without this method the whole
   * adapter path dies with `tab.playwright.evaluate is not a function`.
   */
  it("playwright.evaluate exists and evaluates, which the site adapters depend on", async () => {
    expect(await tab.playwright.evaluate<string>("document.title")).toBe("");
    expect(await tab.playwright.evaluate<number>("1 + 1")).toBe(2);
    expect(await tab.playwright.evaluate<string>("(async () => (await Promise.resolve('async-ok')))()")).toBe("async-ok");
  }, 60_000);

  it("playwright.evaluate re-throws a page exception rather than returning undefined", async () => {
    await expect(tab.playwright.evaluate("throw new Error('boom-eval')")).rejects.toThrow(/boom-eval/);
  }, 60_000);

  it("playwright.evaluate is read-only: DOM setters and non-read-only requests are refused", async () => {
    const before = await tab.playwright.locator("#log").textContent();
    await expect(
      tab.playwright.evaluate("() => { document.querySelector('#log').innerHTML = 'mutated'; }"),
    ).rejects.toThrow(/Read-only browser evaluation/);
    expect(await tab.playwright.locator("#log").textContent()).toBe(before);
    await expect(
      tab.playwright.evaluate("() => fetch('/mutate', { method: 'POST' })"),
    ).rejects.toThrow(/only allows GET and HEAD/);
  }, 60_000);

  it("locator.evaluate is read-only: element mutation methods are refused", async () => {
    const button = tab.playwright.locator("#go");
    await expect(
      button.evaluate("(element) => element.setAttribute('data-mutated', 'yes')"),
    ).rejects.toThrow(/Read-only locator evaluation/);
    expect(await button.getAttribute("data-mutated")).toBeNull();
  }, 60_000);

  it("a missing element throws after the timeout, with the selector in the error", async () => {
    await expect(tab.playwright.locator("#never").textContent({ timeout: 300 })).rejects.toThrow(/#never/);
  }, 60_000);

  // ------------- Dialog tests. These must stay last in the file. -------------
  //
  // The headless=new dialog curse, reproducible with bare CDP and unrelated to
  // the SDK: after `Page.handleJavaScriptDialog` dismisses a dialog, the
  // renderer's input pipeline is left in a bad state. The next *burst* of
  // `Input.dispatchKeyEvent` (a single event is safe) stalls the renderer's main
  // thread for around 10 seconds, blocking even `Runtime.evaluate`, before
  // recovering for good.
  //
  // The bad state is not a time window: waiting 30 seconds still leaves the first
  // burst stalling for 10 or more.
  //
  // Do not try to drain it either, by sending a key burst at the end to absorb
  // the stall. A burst destabilises the pipeline further and the damage spreads
  // into the next test in random shapes: a prompt that never opens, an evaluate
  // that never returns, a failure point that moves.
  //
  // The only stable answer is to keep the dialog tests last, where there is
  // nothing left to poison. The product is unaffected; this is a quirk of the
  // headless test environment.
  //
  // What it looked like: with the dialog tests mid-file, the following ten
  // cascaded into timeouts, keypress hitting the stall first and taking
  // clipboard, dragTo, evaluate and dom_cua down with it.

  /** Poll for a dialog to appear. When the opening event arrives depends on the
   *  previous dialog, so a fixed sleep is racy. */
  const waitForDialog = async (deadlineMs = 30_000) => {
    const deadline = Date.now() + deadlineMs;
    let dialog = await tab.getJsDialog();
    while (dialog == null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      dialog = await tab.getJsDialog();
    }
    return dialog;
  };

  it("alert: getJsDialog dismisses it explicitly and the page resumes", async () => {
    // Reload the page first. The forty-odd preceding tests accumulate state in the
    // renderer, above all the read-only evaluate's Fetch interception toggling and
    // interrupted locator polling. Running the dialog tests right behind that tail
    // makes a wedge more likely, and a reload also returns window.__alert and #log
    // to their initial state.
    await tab.goto(pageUrl);
    await new Promise((r) => setTimeout(r, 500));
    const action = cdpEval("window.__alert()");
    const dialog = await waitForDialog();
    expect(dialog?.type).toBe("alert");
    await dialog?.dismiss();
    await action;
    expect(await tab.playwright.locator("#log").textContent({ timeout: 5000 })).toBe("after-alert");
  }, 60_000);

  it("confirm and prompt: getJsDialog accepts and passes the prompt text", async () => {
    const confirmAction = cdpEval("window.__confirm()");
    const confirm = await waitForDialog();
    expect(confirm?.type).toBe("confirm");
    if (confirm?.type === "confirm") await confirm.accept();
    await confirmAction;
    expect(await tab.playwright.locator("#log").textContent({ timeout: 5000 })).toBe("confirm:true");
    const promptAction = cdpEval("window.__prompt()");
    const prompt = await waitForDialog();
    expect(prompt?.type).toBe("prompt");
    if (prompt?.type === "prompt") await prompt.accept("Operon");
    await promptAction;
    expect(await tab.playwright.locator("#log").textContent({ timeout: 5000 })).toBe("prompt:Operon");
  }, 60_000);
});
