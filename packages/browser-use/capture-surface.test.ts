import { describe, expect, it } from "vitest";
import {
  IabBackend,
  type BrowserUseTab,
  type CaptureSurfaceSize,
  type CdpDriver,
} from "./IabBackend.ts";

type Handler = (params: unknown) => Promise<unknown> | unknown;

function recordingDriver(options: { failCapture?: boolean } = {}) {
  const events: string[] = [];
  const surfaces: Array<CaptureSurfaceSize | null> = [];
  const browserUseActive: Array<{ tabId: number; active: boolean }> = [];
  const tabs = new Map<number, BrowserUseTab>();
  let metricsReads = 0;

  const driver: CdpDriver = {
    attach: async () => {},
    detach: async () => {},
    setCaptureSurface: async (_tabId, size) => {
      surfaces.push(size);
      events.push(size == null ? "surface:null" : `surface:${size.width}x${size.height}`);
    },
    setBrowserUseActive: async (tabId, active) => {
      browserUseActive.push({ tabId, active });
    },
    sendCommand: async (_tabId, method) => {
      events.push(`cdp:${method}`);
      if (method === "Page.getLayoutMetrics") {
        metricsReads += 1;
        const ready = metricsReads >= 2;
        return {
          cssVisualViewport: {
            clientWidth: ready ? 1281 : 1,
            clientHeight: ready ? 801 : 1,
          },
        };
      }
      if (method === "Page.captureScreenshot") {
        if (options.failCapture) throw new Error("capture failed");
        return { data: "image" };
      }
      return {};
    },
    listTabs: async () => [...tabs.values()],
    createTab: async (url, owner) => {
      const tab: BrowserUseTab = {
        id: 7,
        title: "page",
        url: url ?? "about:blank",
        active: true,
        owner,
      };
      tabs.set(tab.id, tab);
      return tab;
    },
    closeTab: async (tabId) => {
      tabs.delete(tabId);
    },
  };
  return { driver, events, surfaces, browserUseActive };
}

function handlersOf(backend: IabBackend): Record<string, Handler> {
  return (backend as unknown as { handlers(): Record<string, Handler> }).handlers();
}

const S = { session_id: "capture-session", turn_id: "turn-1" };

describe("IAB capture surface", () => {
  it("keeps a background paint host for the duration of a lease, and drops it at finalize", async () => {
    const rec = recordingDriver();
    const handlers = handlersOf(new IabBackend({ driver: rec.driver }));
    const tab = (await handlers.createTab(S)) as BrowserUseTab;

    expect(rec.browserUseActive).toEqual([{ tabId: tab.id, active: true }]);

    await handlers.finalizeTabs({ ...S, keep: [{ tabId: tab.id, status: "deliverable" }] });
    expect(rec.browserUseActive).toEqual([
      { tabId: tab.id, active: true },
      { tabId: tab.id, active: false },
    ]);
  });

  it("lays down a real paint surface for captureBeyondViewport, waits for the viewport, captures, then removes it", async () => {
    const rec = recordingDriver();
    const handlers = handlersOf(new IabBackend({ driver: rec.driver }));
    const tab = (await handlers.createTab(S)) as BrowserUseTab;

    await handlers.executeCdp({
      ...S,
      target: { tabId: tab.id },
      method: "Page.captureScreenshot",
      commandParams: {
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 1280.2, height: 800.1, scale: 1 },
      },
    });

    expect(rec.surfaces).toEqual([
      { width: 1281, height: 801 },
      null,
    ]);
    expect(rec.events).toEqual([
      "surface:1281x801",
      "cdp:Page.getLayoutMetrics",
      "cdp:Page.getLayoutMetrics",
      "cdp:Page.captureScreenshot",
      "surface:null",
    ]);
  });

  it("an ordinary viewport screenshot leaves the paint surface alone", async () => {
    const rec = recordingDriver();
    const handlers = handlersOf(new IabBackend({ driver: rec.driver }));
    const tab = (await handlers.createTab(S)) as BrowserUseTab;

    await handlers.executeCdp({
      ...S,
      target: { tabId: tab.id },
      method: "Page.captureScreenshot",
      commandParams: { format: "jpeg" },
    });

    expect(rec.surfaces).toEqual([]);
    expect(rec.events).toEqual(["cdp:Page.captureScreenshot"]);
  });

  it("a throwing screenshot still removes the capture surface in finally", async () => {
    const rec = recordingDriver({ failCapture: true });
    const handlers = handlersOf(new IabBackend({ driver: rec.driver }));
    const tab = (await handlers.createTab(S)) as BrowserUseTab;

    await expect(
      handlers.executeCdp({
        ...S,
        target: { tabId: tab.id },
        method: "Page.captureScreenshot",
        commandParams: {
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 1280.2, height: 800.1, scale: 1 },
        },
      }),
    ).rejects.toThrow("capture failed");

    expect(rec.surfaces.at(-1)).toBeNull();
  });
});
