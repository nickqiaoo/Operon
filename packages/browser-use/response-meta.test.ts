// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Browser, setupBrowserRuntime } from "./sdk/index.ts";
import {
  installBrowserResponseMetaHook,
  recordTabMutation,
  registerTabResponseContext,
} from "./sdk/response-meta.ts";
import type { BackendConnection } from "./sdk/transport.ts";

interface AfterHook {
  run(): Promise<void> | void;
}

function testBrowser(): {
  browser: Browser;
  hooks: AfterHook[];
  metas: Array<Record<string, unknown>>;
} {
  const hooks: AfterHook[] = [];
  const metas: Array<Record<string, unknown>> = [];
  const cdpListeners = new Set<(event: {
    method: string;
    params?: unknown;
    source: { tabId: number };
  }) => void>();
  (globalThis as Record<string, unknown>).nodeRepl = {
    addAfterSubmittedCodeHook(hook: AfterHook) {
      hooks.push(hook);
    },
    setResponseMeta(meta: Record<string, unknown>) {
      metas.push(meta);
    },
  };
  void setupBrowserRuntime({ globals: {} });
  const conn = {
    async sendSessionRequest(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> {
      if (method === "getTabs") {
        return [{
          active: true,
          id: 1,
          title: "Example",
          url: "https://example.com/path?secret=yes#fragment",
        }];
      }
      if (method === "executeCdp") {
        if (params?.method === "Page.reload") {
          queueMicrotask(() => {
            for (const listener of cdpListeners) {
              listener({
                method: "Page.frameNavigated",
                params: { frame: { id: "main", url: "https://example.com/path" } },
                source: { tabId: 1 },
              });
              listener({
                method: "Page.loadEventFired",
                source: { tabId: 1 },
              });
            }
          });
          return {};
        }
        if (params?.method === "Runtime.evaluate") {
          return {
            result: {
              value: { href: "https://example.com/path?secret=yes#fragment" },
            },
          };
        }
        if (params?.method === "Page.captureScreenshot") return { data: "AA==" };
      }
      return {};
    },
    onCdpEvent: (listener: (event: {
      method: string;
      params?: unknown;
      source: { tabId: number };
    }) => void) => {
      cdpListeners.add(listener);
      return () => cdpListeners.delete(listener);
    },
    onDownloadChange: () => () => {},
    close: () => {},
  };
  const browser = new Browser({
    conn,
    info: {
      id: "iab-meta",
      name: "Operon",
      type: "iab",
      capabilities: {},
      apiSupportOverrides: {
        "Tab.markDeliverable": true,
        "Tab.markHandoff": true,
        "Tabs.content": true,
        "Tabs.finalize": true,
      },
    },
    socketPath: "/tmp/meta.sock",
  } as never);
  return { browser, hooks, metas };
}

describe("Browser response metadata", () => {
  beforeEach(() => {
    delete (globalThis as { nodeRepl?: unknown }).nodeRepl;
  });

  it("captures the used tab after a successful mutating command", async () => {
    const { browser, hooks, metas } = testBrowser();
    const tab = await browser.tabs.selected();
    if (tab == null) throw new Error("missing test tab");
    metas.length = 0;
    await tab.reload();
    await hooks[0].run();

    expect(metas.at(-1)).toEqual({
      "codex/browserUse": true,
      "codex/toolSurface": {
        backend: "iab",
        browserId: "iab-meta",
        kind: "browserUse",
        openTabIds: ["1"],
        screenshot: {
          pageUrl: "https://example.com",
          tabId: "1",
          url: "data:image/png;base64,AA==",
        },
      },
      browser_use: {
        url: "https://example.com/path",
      },
    });
  });

  it("marks the browser session ended after finalize", async () => {
    const { browser, hooks, metas } = testBrowser();
    metas.length = 0;
    await browser.tabs.finalize();
    await hooks[0].run();
    expect(metas.at(-1)?.["codex/toolSurface"]).toEqual({
      backend: "iab",
      browserId: "iab-meta",
      kind: "browserUse",
      openTabIds: [],
      sessionEnded: true,
    });
  });
});

/**
 * The SDK is one module instance shared by every conversation in a kernel. The
 * end-of-exec report (current URL, tab screenshot) must stay with the
 * conversation that drove the tab: it used to be kept in module variables and
 * flushed by a hook only the first conversation had, so a second conversation
 * got no report and its tab ended up in the first one's tool result.
 */
type Hook = { run(): Promise<void> | void };

function fakeKernel() {
  let current: object = {};
  const hooks = new Map<object, Hook[]>();
  const meta = new Map<object, Record<string, unknown>[]>();
  const repl = {
    get contextKey() { return current; },
    addAfterSubmittedCodeHook(hook: Hook) {
      hooks.set(current, [...(hooks.get(current) ?? []), hook]);
    },
    setResponseMeta(m: Record<string, unknown>) {
      meta.set(current, [...(meta.get(current) ?? []), m]);
    },
  };
  (globalThis as { nodeRepl?: unknown }).nodeRepl = repl;
  return {
    enter(ctx: object) { current = ctx; },
    /** The kernel runs only the finishing context's own hooks. */
    async finishExec(ctx: object) {
      current = ctx;
      for (const hook of hooks.get(ctx) ?? []) await hook.run();
    },
    hooksOf: (ctx: object) => hooks.get(ctx) ?? [],
    metaOf: (ctx: object) => meta.get(ctx) ?? [],
  };
}

function fakeConn(url: string): BackendConnection {
  return {
    sendSessionRequest: async (method: string) =>
      method === "getTabs" ? [{ id: 7, active: true, url }] : {},
  } as unknown as BackendConnection;
}

const context = { browserId: "iab-1", browserName: "IAB", browserType: "iab" as const };

describe("browser response meta is per conversation", () => {
  afterEach(() => {
    delete (globalThis as { nodeRepl?: unknown }).nodeRepl;
  });

  it("each conversation installs its own flush hook", () => {
    const k = fakeKernel();
    const a = {};
    const b = {};
    k.enter(a);
    installBrowserResponseMetaHook();
    installBrowserResponseMetaHook();
    k.enter(b);
    installBrowserResponseMetaHook();
    expect(k.hooksOf(a)).toHaveLength(1);
    expect(k.hooksOf(b)).toHaveLength(1);
  });

  it("one conversation's tab is reported in its own result, not another's", async () => {
    const k = fakeKernel();
    const a = {};
    const b = {};
    k.enter(a);
    installBrowserResponseMetaHook();
    k.enter(b);
    installBrowserResponseMetaHook();

    const tabB = {};
    registerTabResponseContext(tabB, fakeConn("https://b.example/page"), 7, context);
    k.enter(b);
    recordTabMutation(tabB);

    await k.finishExec(a);
    expect(k.metaOf(a)).toEqual([]);

    await k.finishExec(b);
    expect(k.metaOf(b)).toHaveLength(1);
    expect(k.metaOf(b)[0]).toMatchObject({ browser_use: { url: "https://b.example/page" } });
  });
});
