// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { Browser, setupBrowserRuntime } from "./sdk/index.ts";

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
