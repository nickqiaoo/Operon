// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IabBackend, type CdpDriver } from "./IabBackend.ts";
import { BUILD_FLAVOR_ENV, backendSocketDir } from "./wire.ts";
import { setupBrowserRuntime, INJECTED_CONSTANT, type Tab } from "./sdk/index.ts";

/**
 * The Playwright injection layer of our SDK.
 *
 * Unlike the sdk-differential suite, the injection expression cannot be compared
 * byte for byte with the reference: it bundles its own Playwright, frozen at some
 * version, while we use the blob playwright-core publishes, so the bytes
 * necessarily differ. What is asserted here is structure: the wrapper shape, the
 * options, the cache key algorithm, and that the second call does not resend
 * 191KB.
 *
 * Whether the injection itself works (the selector engine, ariaSnapshot, ref
 * lookup) is verified against a real Chrome in `playwright-injected.test.ts`.
 * This file covers only the SDK-to-backend leg.
 */

const SESSION = "PWINJECT";
const FLAVOR = "operon-pwinject";

interface CdpCall {
  method: string;
  params: Record<string, unknown>;
}

describe("our SDK injects Playwright through executeCdpWithCachedExpression", () => {
  let hidden: string;
  let proxyPath: string;
  let backend: IabBackend;
  let server: net.Server;
  const sockets = new Set<net.Socket>();
  /** Records the executeCdpWithCachedExpression requests the SDK sends. */
  const cached: Array<Record<string, unknown>> = [];
  const cdp: CdpCall[] = [];
  let tab: Tab;

  beforeAll(async () => {
    hidden = fs.mkdtempSync(path.join(os.tmpdir(), "pwinject-"));
    const publicDir = backendSocketDir();
    fs.mkdirSync(publicDir, { recursive: true });
    proxyPath = path.join(publicDir, `pwinject-${process.pid}.sock`);
    fs.rmSync(proxyPath, { force: true });

    const driver: CdpDriver = {
      attach: async () => {},
      detach: async () => {},
      listTabs: async () => [{ id: 1, title: "t", url: "about:blank", active: true }],
      createTab: async (url, owner) => ({ id: 2, title: "n", url: url ?? "", active: true, owner }) as never,
      closeTab: async () => {},
      sendCommand: async (_tabId, method, params) => {
        cdp.push({ method, params: (params ?? {}) as Record<string, unknown> });
        return { result: { type: "object", value: {} } };
      },
    };
    backend = new IabBackend({ driver, socketDir: hidden, buildFlavor: FLAVOR } as never);
    const realPath = await backend.listen();

    // A proxy purely to record the frames the SDK emits: the backend is hidden and
    // the client only ever sees the proxy.
    const { encodeFrame, decodeFrames } = await import("./wire.ts");
    server = net.createServer((client) => {
      sockets.add(client);
      const up = net.createConnection(realPath);
      sockets.add(up);
      let cb: Buffer = Buffer.alloc(0);
      let ub: Buffer = Buffer.alloc(0);
      client.on("data", (d) => {
        cb = Buffer.concat([cb, d]);
        const { messages, remainingData } = decodeFrames(cb);
        cb = remainingData;
        for (const m of messages) {
          const msg = JSON.parse(m) as { method?: string; params?: Record<string, unknown> };
          if (msg.method === "executeCdpWithCachedExpression") cached.push(msg.params ?? {});
          up.write(encodeFrame(m));
        }
      });
      up.on("data", (d) => {
        ub = Buffer.concat([ub, d]);
        const { messages, remainingData } = decodeFrames(ub);
        ub = remainingData;
        for (const m of messages) client.write(encodeFrame(m));
      });
      client.on("error", () => {});
      up.on("error", () => {});
      client.on("close", () => up.destroy());
    });
    await new Promise<void>((r) => server.listen(proxyPath, () => r()));

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
    };

    const globals: Record<string, unknown> = {};
    await setupBrowserRuntime({ globals });
    const agent = globals.agent as { browsers: { get(id: string): Promise<{ tabs: { "new"(): Promise<typeof tab> } }> } };
    const browser = await agent.browsers.get("iab");
    tab = await browser.tabs.new();
  }, 60_000);

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await backend.close?.();
    fs.rmSync(proxyPath, { force: true });
    fs.rmSync(hidden, { recursive: true, force: true });
  });

  it("the first injection carries the full 191KB source plus a cache key", async () => {
    await tab.playwright.locator("body").count();
    expect(cached.length).toBe(1);
    const p = cached[0];
    expect(p.method).toBe("Runtime.evaluate");
    expect(p.target).toEqual({ tabId: Number(tab.id) }); // Numbers on the wire; tab.id is a string at the model layer.
    expect(String(p.expressionCacheKey)).toMatch(/^playwright-injected:[A-Za-z0-9_-]+$/);
    const cp = p.commandParams as Record<string, unknown>;
    expect(cp.awaitPromise).toBe(true);
    expect(cp.returnByValue).toBe(true);
    expect(typeof cp.expression).toBe("string");
    expect((cp.expression as string).length, "should be the complete Playwright blob").toBeGreaterThan(100_000);
  });

  it("the injection expression matches the reference structurally; differing bytes are expected", () => {
    const expr = (cached[0].commandParams as { expression: string }).expression;
    expect(expr).toContain(INJECTED_CONSTANT);
    expect(expr).toContain(`if (!window.${INJECTED_CONSTANT})`);
    // It passes window, not globalThis.
    expect(expr).toContain("(window, {");

    /**
     * Assert against the options object we pass, never against the whole
     * expression. `isUtilityWorld` is an InjectedScript option name and appears
     * inside the Playwright blob itself, so a not.toContain over the full text
     * always reports a false positive. Extract the JSON from `(window, {...})`
     * first and check that.
     */
    const optionsJson = /\(window, (\{.*?\})\);/s.exec(expr)?.[1];
    expect(optionsJson, "could not extract the options JSON").toBeTruthy();
    const options = JSON.parse(optionsJson!) as Record<string, unknown>;
    expect(options).toEqual({
      isUnderTest: false,
      sdkLanguage: "javascript",
      testIdAttributeName: "data-testid",
      stableRafCount: 1,
      browserName: "chromium",
      customEngines: [],
    });
    // isUtilityWorld is deliberately not passed: passing it would run the
    // injection with utility-world semantics.
    expect(Object.keys(options)).not.toContain("isUtilityWorld");
  });

  it("the cache key is playwright-injected: followed by the base64url sha256 of the expression", async () => {
    const { createHash } = await import("node:crypto");
    const expr = (cached[0].commandParams as { expression: string }).expression;
    const want = `playwright-injected:${createHash("sha256").update(expr).digest("base64url")}`;
    expect(cached[0].expressionCacheKey).toBe(want);
  });

  it("a repeat call on the same tab sends nothing at all", async () => {
    await tab.playwright.locator("body").count();
    await tab.playwright.locator("body").count();
    expect(cached.length, "a tab already injected should not be sent again").toBe(1);
  });

  it("a different tab sends only the cache key, not the 191KB again", async () => {
    const globals = (globalThis as Record<string, unknown>) as { agent?: unknown };
    void globals;
    const agentAny = (await (async () => {
      const g: Record<string, unknown> = {};
      await setupBrowserRuntime({ globals: g });
      return g.agent as { browsers: { get(id: string): Promise<{ tabs: { "new"(): Promise<typeof tab> } }> } };
    })())!;
    const browser2 = await agentAny.browsers.get("iab");
    const tab2 = await browser2.tabs.new();
    await tab2.playwright.locator("body").count();

    expect(cached.length, "a new tab should produce a second request").toBe(2);
    const cp = cached[1].commandParams as Record<string, unknown>;
    // The point: expression is dropped and only the key remains, which is how
    // 191KB becomes tens of bytes.
    expect(cp.expression, "the second call should not resend expression").toBeUndefined();
    expect(cached[1].expressionCacheKey).toBe(cached[0].expressionCacheKey);
  });

  it("the backend really executed the expression: Runtime.evaluate reached the driver", () => {
    const evals = cdp.filter((c) => c.method === "Runtime.evaluate");
    expect(evals.length).toBeGreaterThan(0);
    expect(String(evals[0].params.expression)).toContain(INJECTED_CONSTANT);
  });
});
