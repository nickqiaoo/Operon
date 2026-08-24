// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Tab } from "./sdk/index.ts";
import type { CdpEventNotification } from "./sdk/transport.ts";

interface RecordedRequest {
  method: string;
  params?: Record<string, unknown>;
}

function testTab(id: number): {
  emit(event: CdpEventNotification): void;
  listenerCount(): number;
  requests: RecordedRequest[];
  tab: Tab;
} {
  const listeners = new Set<(event: CdpEventNotification) => void>();
  const requests: RecordedRequest[] = [];
  const conn = {
    async sendSessionRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
      requests.push({ method, params });
      if (
        method === "executeCdp"
        && (params?.method === "Runtime.evaluate")
      ) {
        return { result: { value: { href: "https://example.com/", readyState: "loading" } } };
      }
      return {};
    },
    onCdpEvent(cb: (event: CdpEventNotification) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onDownloadChange: () => () => {},
    close: () => {},
  };
  return {
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
    requests,
    tab: new Tab(conn as never, id),
  };
}

describe("Browser CDP event isolation", () => {
  async function waitForSubscription(listenerCount: () => number): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (listenerCount() > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("CDP event listener was not installed");
  }

  it("ignores a navigation event emitted by a different tab", async () => {
    const { emit, listenerCount, tab } = testTab(7);
    let resolved = false;
    const waiting = tab.playwright.waitForLoadState({ timeoutMs: 1_000 }).then(() => {
      resolved = true;
    });
    await waitForSubscription(listenerCount);

    emit({ source: { tabId: 8 }, method: "Page.loadEventFired" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);

    emit({ source: { tabId: 7 }, method: "Page.loadEventFired" });
    await waiting;
    expect(resolved).toBe(true);
  });

  it("disables file chooser interception after a top-level chooser event", async () => {
    const { emit, listenerCount, requests, tab } = testTab(11);
    const waiting = tab.playwright.waitForEvent("filechooser", { timeoutMs: 1_000 });
    await waitForSubscription(listenerCount);

    emit({
      source: { tabId: 12 },
      method: "Page.fileChooserOpened",
      params: { backendNodeId: 2, mode: "selectSingle" },
    });
    emit({
      source: { tabId: 11 },
      method: "Page.fileChooserOpened",
      params: { backendNodeId: 3, mode: "selectMultiple" },
    });

    const chooser = await waiting;
    expect(chooser.isMultiple()).toBe(true);
    const intercepts = requests
      .filter(({ params }) => params?.method === "Page.setInterceptFileChooserDialog")
      .map(({ params }) => params?.commandParams);
    expect(intercepts).toEqual([{ enabled: true }, { enabled: false }]);
  });

  it("rejects OOPIF file upload and still disables interception", async () => {
    const { emit, listenerCount, requests, tab } = testTab(13);
    const waiting = tab.playwright.waitForEvent("filechooser", { timeoutMs: 1_000 });
    await waitForSubscription(listenerCount);
    emit({
      source: { tabId: 13, sessionId: "child-session", targetId: "child-target" },
      method: "Page.fileChooserOpened",
      params: { backendNodeId: 4, mode: "selectSingle" },
    });
    await expect(waiting).rejects.toThrow(
      "File uploads in out-of-process frames are not supported.",
    );
    expect(
      requests.some(
        ({ params }) =>
          params?.method === "Page.setInterceptFileChooserDialog"
          && (params.commandParams as { enabled?: boolean } | undefined)?.enabled === false,
      ),
    ).toBe(true);
  });
});
