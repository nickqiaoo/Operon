// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { acquireChromeE2eLock, releaseChromeE2eLock } from "./chrome-e2e-lock.ts";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";

/**
 * Guards the foundation the SDK is built on.
 *
 * Background: the largest single piece of the reference client, some 191KB of a
 * 991KB bundle, is Playwright's own injectedScript verbatim. Its fingerprints are
 * `__pw_`, `expectHitTarget` and
 * `generateSelectorSimple` / `internal:role` / `internal:has-text` / `internal:testid`。
 * Playwright is Apache-2.0, so this part can be used as-is rather than rewritten.
 *
 * Using it as-is has a cost, and this file guards that cost:
 *
 * 1. `lib/generated/` is not in playwright-core's `exports` map. Requiring
 *    `playwright-core/lib/generated/injectedScriptSource.js` directly raises
 *    `ERR_PACKAGE_PATH_NOT_EXPORTED`. The only way in is to resolve
 *    `package.json` and build the path by hand, which depends on internal layout
 *    that upstream is free to change at any time.
 * 2. The root `@playwright/test` is a caret range, so an `npm install` alone can
 *    move playwright-core forward. Drift does not require anyone to upgrade
 *    deliberately.
 *
 * For production, `playwright-core` has to be a direct dependency of
 * `@operon/browser-use`, pinned to an exact version, rather than borrowed as a
 * transitive devDependency of `@playwright/test`. That one is for tests, and a
 * shipping SDK depending on it is wrong wiring.
 *
 * One alternative is to compile the injectedScript into your own bundle, which
 * freezes it at whatever Playwright version was current. Reading Playwright's own
 * `source` export and following its bootstrap convention instead means moving
 * with upstream, and the price of that is this test file.
 */

const require_ = createRequire(import.meta.url);

/** The only way around the `exports` map: resolve package.json for the directory
 *  and build the internal path from it. */
function injectedScriptSourcePath(): string {
  const pkgDir = path.dirname(require_.resolve("playwright-core/package.json"));
  return path.join(pkgDir, "lib/generated/injectedScriptSource.js");
}

function playwrightCoreVersion(): string {
  return require_("playwright-core/package.json").version as string;
}

describe("Playwright injectedScript: the blob and its calling convention (no browser needed)", () => {
  it("the blob is at the internal path and exports a source string", () => {
    const p = injectedScriptSourcePath();
    expect(existsSync(p), `playwright-core moved injectedScript: ${p}`).toBe(true);

    const mod = require_(p) as { source?: unknown };
    expect(typeof mod.source, "injectedScriptSource no longer exports a source string").toBe("string");
    // 1.58.2 is 305,013 characters. A loose lower bound is enough; the point is to
    // catch it being replaced by a stub or an empty string.
    expect((mod.source as string).length).toBeGreaterThan(100_000);
  });

  it("the bootstrap convention holds: after eval, module.exports.InjectedScript() returns a constructor", () => {
    const { source } = require_(injectedScriptSourcePath()) as { source: string };

    /**
     * This is how Playwright itself uses it (`playwright-core/lib/server/dom.js`):
     *
     *   const source = `
     *     (() => {
     *     const module = {};
     *     ${rawInjectedScriptSource.source}
     *     return new (module.exports.InjectedScript())(globalThis, ${JSON.stringify(options)});
     *     })();
     *   `;
     *
     * Running it once in a vm is enough to confirm the convention has not changed,
     * with no browser involved: what drifts is the export shape, not browser
     * behaviour. The constructor is only retrieved, never invoked, since `new`
     * needs a real DOM; that belongs to the CDP tests below.
     */
    const sandbox: { module: { exports?: Record<string, unknown> } } = { module: {} };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);

    expect(
      Object.keys(sandbox.module.exports ?? {}),
      "the injectedScript export shape changed; the bootstrap expression has to follow",
    ).toContain("InjectedScript");

    const factory = sandbox.module.exports?.InjectedScript;
    expect(typeof factory).toBe("function");
    expect(
      typeof (factory as () => unknown)(),
      "module.exports.InjectedScript() no longer returns a constructor",
    ).toBe("function");
  });
});

// ---- The rest needs a real browser, to prove the blob can be driven over bare
//      CDP without loading Playwright's runtime. ----

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let chrome: ChildProcess | undefined;
let userDir: string | undefined;

afterAll(async () => {
  // Wait for Chrome to actually exit before removing the user-data-dir. kill()
  // only sends a signal, and Chrome keeps writing for a moment after receiving
  // it, so an immediate rmSync hits ENOTEMPTY (`force` swallows ENOENT, not
  // that). Running the file alone can get away with it on timing; running the
  // full suite does not.
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise<void>((r) => chrome?.once("exit", () => r()));
    chrome.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    }
  }
  // Even so, cleanup is best effort: a temp directory that will not delete must
  // not fail the test.
  if (userDir) {
    try {
      rmSync(userDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* The system reclaims tmp anyway. */
    }
  }
  releaseChromeE2eLock();
});

interface CdpSession {
  evaluate(expression: string): Promise<{ objectId?: string; value?: unknown }>;
  callOn(objectId: string, fnDecl: string, args?: unknown[]): Promise<unknown>;
  close(): void;
}

/** A minimal CDP client, deliberately not using Playwright's runtime: the point
 *  is to prove the blob alone is enough. */
async function openChrome(): Promise<CdpSession> {
  // Running several real-Chrome e2e files in parallel wedges the renderer
  // pipeline permanently; see chrome-e2e-lock.ts.
  await acquireChromeE2eLock();
  // Port 0 plus DevToolsActivePort, immune to colliding with a leaked Chrome (see
  // the note in sdk-locator-real).
  userDir = mkdtempSync(path.join(os.tmpdir(), "pw-injected-"));
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let port = 0;
  const portFile = path.join(userDir, "DevToolsActivePort");
  for (let i = 0; i < 60 && !port; i++) {
    try {
      port = Number(readFileSync(portFile, "utf8").split("\n")[0]) || 0;
    } catch { /* Not written yet. */ }
    if (!port) await new Promise((r) => setTimeout(r, 150));
  }
  if (!port) throw new Error("headless Chrome did not start (no DevToolsActivePort)");

  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      target = list.find((t) => t.type === "page");
    } catch {
      /* Chrome is not up yet. */
    }
    if (!target) await new Promise((r) => setTimeout(r, 150));
  }
  if (!target) throw new Error("headless Chrome did not start");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("cannot connect to the CDP WebSocket"));
  });

  let id = 0;
  const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; error?: unknown; result?: unknown };
    if (m.id === undefined) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result as never);
  };

  function send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve: resolve as (v: never) => void, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  }

  interface EvalResult {
    result: { objectId?: string; value?: unknown };
    exceptionDetails?: { exception?: { description?: string } };
  }

  return {
    async evaluate(expression) {
      const r = await send<EvalResult>("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: false,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
      return r.result;
    },
    async callOn(objectId, fnDecl, args = []) {
      const r = await send<EvalResult>("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fnDecl,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "call failed");
      return r.result.value;
    },
    close: () => ws.close(),
  };
}

/** The same options the reference uses: `isUtilityWorld`, `testIdAttributeName`,
 *  `stableRafCount` and the rest. */
const INJECTED_OPTIONS = {
  isUnderTest: false,
  sdkLanguage: "javascript",
  testIdAttributeName: "data-testid",
  stableRafCount: 1,
  browserName: "chromium",
  isUtilityWorld: false,
  customEngines: [] as unknown[],
};

describe.skipIf(!existsSync(CHROME))("Playwright injectedScript driven over bare CDP (needs Chrome)", () => {
  it("bootstraps into the page: selector engine, reverse generation, ariaSnapshot, ref lookup, handle reuse", async () => {
    const { source } = require_(injectedScriptSourcePath()) as { source: string };
    const cdp = await openChrome();
    try {
      await cdp.evaluate(
        `document.body.innerHTML = \`<h1>Checkout</h1>
           <button id="go">Submit order</button>
           <label for="em">Email</label><input id="em" type="email">
           <div data-testid="card"><span>hello</span></div>\`; "ok"`,
      );

      // ---- Cold start: send the whole blob once, without returnByValue, and keep
      //      the objectId as a handle. ----
      const handle = await cdp.evaluate(
        `(() => {
           const module = {};
           ${source}
           return new (module.exports.InjectedScript())(globalThis, ${JSON.stringify(INJECTED_OPTIONS)});
         })()`,
      );
      expect(handle.objectId, "no objectId after instantiating injectedScript").toBeTruthy();
      const h = handle.objectId as string;

      // ---- Hot path: reuse the handle and send only tens of bytes per call. ----
      // This is the mechanism behind `executeCdpWithCachedExpression`: the payload
      // goes over the wire exactly once.
      const q = (selector: string, prop: string) =>
        cdp.callOn(
          h,
          `function(sel) { const el = this.querySelector(this.parseSelector(sel), document, false); return el && el.${prop}; }`,
          [selector],
        );

      expect(await q("internal:role=button", "textContent")).toBe("Submit order");
      expect(await q('internal:label="Email"i', "id")).toBe("em");
      expect(await q('internal:testid=[data-testid="card"s]', "textContent")).toBe("hello");
      expect(await q('internal:text="hello"i', "tagName")).toBe("SPAN");

      // Reverse selector generation comes free with it.
      expect(
        await cdp.callOn(h, `function() { return this.generateSelectorSimple(document.getElementById("go")); }`),
      ).toBe('internal:role=button[name="Submit order"i]');

      // ---- The agent's actual main path: take a ref from ariaSnapshot, then
      //      resolve that ref back to an element. ----
      const snapshot = (await cdp.callOn(
        h,
        `function() { return this.ariaSnapshot(document.body, { mode: "ai", refPrefix: "" }); }`,
      )) as string;
      expect(snapshot).toContain('button "Submit order" [ref=');

      const ref = /button "Submit order" \[ref=([^\]]+)\]/.exec(snapshot)?.[1];
      expect(ref, "ariaSnapshot(mode:ai) gave the button no ref").toBeTruthy();
      expect(
        await cdp.callOn(
          h,
          `function(r) { const el = this.querySelector(this.parseSelector("aria-ref=" + r), document, false); return el && el.outerHTML; }`,
          [ref],
        ),
      ).toBe('<button id="go">Submit order</button>');
    } finally {
      cdp.close();
    }
  }, 300_000);  // Includes waiting on the chrome-e2e lock, with other Chrome files
                // possibly ahead in the queue.
});

describe("diagnostics", () => {
  it("records the current playwright-core version, to make drift easy to locate", () => {
    const v = playwrightCoreVersion();
    expect(typeof v).toBe("string");
    // No assertion on the exact version: a caret range moves on its own. The
    // convention tests above are the real guard.
    // Verified working with 1.58.2.
  });
});
