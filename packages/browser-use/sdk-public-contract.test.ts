// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { Browser, Tab, Tabs } from "./sdk/index.ts";

function fakeConnection() {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const cdpListeners = new Set<(event: {
    source: { tabId: number };
    method: string;
    params?: unknown;
  }) => void>();
  const sendSessionRequest = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    requests.push({ method, params });
    if (method === "getTabs") {
      return [{ id: 7, title: "Seven", url: "https://example.com", active: true }];
    }
    if (method === "createTab") {
      return { id: 8, title: "Eight", url: "about:blank", active: true };
    }
    if (method === "executeCdp" && params?.method === "Page.captureScreenshot") {
      return { data: Buffer.from([137, 80, 78, 71]).toString("base64") };
    }
    if (method === "executeCdp" && params?.method === "Runtime.evaluate") {
      return { result: { value: 1 } };
    }
    if (method === "executeCdp" && params?.method === "Page.getLayoutMetrics") {
      return {
        cssVisualViewport: {
          clientHeight: 600,
          clientWidth: 800,
          pageX: 0,
          pageY: 0,
        },
      };
    }
    if (method === "executeCdp" && params?.method === "Page.startScreencast") {
      queueMicrotask(() => {
        for (const listener of cdpListeners) {
          listener({
            source: { tabId: 7 },
            method: "Page.screencastFrame",
            params: {
              data: Buffer.from([137, 80, 78, 71]).toString("base64"),
              sessionId: 1,
            },
          });
        }
      });
      return {};
    }
    if (method === "executeUnhandledCommand" && params?.type === "browser_visibility_get") {
      return { visible: true };
    }
    return null;
  });
  return {
    connection: {
      sendSessionRequest,
      onCdpEvent: (listener: (event: {
        source: { tabId: number };
        method: string;
        params?: unknown;
      }) => void) => {
        cdpListeners.add(listener);
        return () => cdpListeners.delete(listener);
      },
      onDownloadChange: () => () => {},
      close: () => {},
    } as never,
    requests,
  };
}

describe("Browser SDK public wire contract", () => {
  it("maps numeric wire tab ids to string public ids", async () => {
    const { connection } = fakeConnection();
    const tabs = new Tabs(connection);
    expect(await tabs.list()).toEqual([
      { id: "7", title: "Seven", url: "https://example.com" },
    ]);
    expect((await tabs.selected())?.id).toBe("7");
    expect((await tabs.new()).id).toBe("8");
    expect((await tabs.get("7")).id).toBe("7");
  });

  it("maps public ids back to integer tabId and sends structured finalize entries", async () => {
    const { connection, requests } = fakeConnection();
    const tabs = new Tabs(connection);
    const tab = new Tab(connection, 7);
    await tabs.finalize({ keep: [{ tab, status: "handoff" }] });
    expect(requests.at(-1)).toEqual({
      method: "finalizeTabs",
      params: { keep: [{ tabId: 7, status: "handoff" }] },
    });
  });

  it("returns screenshot bytes instead of a data URL", async () => {
    const { connection } = fakeConnection();
    const bytes = await new Tab(connection, 7).screenshot();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toEqual([137, 80, 78, 71]);
  });

  it("maps current CUA button and modifier options to CDP input events", async () => {
    const { connection, requests } = fakeConnection();
    const tab = new Tab(connection, 7);
    await tab.cua.click({
      button: 2,
      keypress: ["Control"],
      x: 12,
      y: 34,
    });
    const inputEvents = requests
      .filter(({ method, params }) =>
        method === "executeCdp" && params?.method?.toString().startsWith("Input."))
      .map(({ params }) => params?.commandParams);
    expect(inputEvents).toEqual([
      expect.objectContaining({ type: "keyDown", key: "Control", modifiers: 2 }),
      expect.objectContaining({ type: "mouseMoved", modifiers: 2, x: 12, y: 34 }),
      expect.objectContaining({
        type: "mousePressed",
        button: "middle",
        buttons: 4,
        modifiers: 2,
        x: 12,
        y: 34,
      }),
      expect.objectContaining({
        type: "mouseReleased",
        button: "middle",
        buttons: 0,
        modifiers: 2,
        x: 12,
        y: 34,
      }),
      expect.objectContaining({ type: "keyUp", key: "Control", modifiers: 2 }),
    ]);
  });

  it("capabilities list descriptors asynchronously and resolve documented implementations", async () => {
    const { connection } = fakeConnection();
    const browser = new Browser({
      conn: connection,
      socketPath: "/tmp/browser.sock",
      info: {
        id: "iab",
        name: "Operon",
        type: "iab",
        capabilities: {
          browser: [
            { id: "visibility", description: "Show or hide the browser." },
            { id: "viewport", description: "Override the viewport." },
          ],
        },
      },
    });
    expect(await browser.capabilities.list()).toEqual([
      { id: "visibility", description: "Show or hide the browser." },
      { id: "viewport", description: "Override the viewport." },
    ]);
    const visibility = await browser.capabilities.get("visibility") as {
      documentation(): Promise<string>;
      get(): Promise<boolean>;
    };
    expect(await visibility.documentation()).toContain("# Browser Capability: visibility");
    expect(await visibility.get()).toBe(true);
  });
});
