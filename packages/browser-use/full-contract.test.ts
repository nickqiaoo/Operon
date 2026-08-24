import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  IabBackend,
  type BrowserUseDownloadChange,
  type BrowserUseTab,
  type CaptureSurfaceSize,
  type CdpDriver,
  type CdpEvent,
} from "./IabBackend.ts";
import { decodeFrames, encodeFrame } from "./wire.ts";

interface RpcReply {
  id?: number;
  result?: unknown;
  error?: { message: string };
  method?: string;
  params?: unknown;
}

class RawClient {
  private socket!: net.Socket;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private sequence = 0;
  private readonly pending = new Map<number, (reply: RpcReply) => void>();
  private readonly notifications: RpcReply[] = [];
  private readonly notificationWaiters = new Map<string, Array<(params: unknown) => void>>();

  async connect(socketPath: string): Promise<void> {
    this.socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const decoded = decodeFrames(this.buffer);
      this.buffer = decoded.remainingData;
      for (const frame of decoded.messages) {
        const message = JSON.parse(frame) as RpcReply;
        if (message.id != null) {
          this.pending.get(message.id)?.(message);
          this.pending.delete(message.id);
          continue;
        }
        this.notifications.push(message);
        if (message.method == null) continue;
        const waiter = this.notificationWaiters.get(message.method)?.shift();
        waiter?.(message.params);
      }
    });
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (reply) => {
        if (reply.error != null) reject(new Error(reply.error.message));
        else resolve(reply.result);
      });
      this.socket.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    });
  }

  waitForNotification(method: string, timeoutMs = 1_000): Promise<unknown> {
    const existingIndex = this.notifications.findIndex((item) => item.method === method);
    if (existingIndex >= 0) {
      const [existing] = this.notifications.splice(existingIndex, 1);
      return Promise.resolve(existing.params);
    }
    return new Promise((resolve, reject) => {
      const waiters = this.notificationWaiters.get(method) ?? [];
      const timer = setTimeout(() => {
        const current = this.notificationWaiters.get(method) ?? [];
        this.notificationWaiters.set(
          method,
          current.filter((waiter) => waiter !== onNotification),
        );
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const onNotification = (params: unknown) => {
        clearTimeout(timer);
        resolve(params);
      };
      waiters.push(onNotification);
      this.notificationWaiters.set(method, waiters);
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

interface SentCommand {
  tabId: number;
  method: string;
  params?: unknown;
  sessionId?: string;
}

function contractBrowser() {
  const tabs = new Map<number, BrowserUseTab>();
  const commands: SentCommand[] = [];
  const closed: number[] = [];
  const selected: number[] = [];
  const cursors: Array<{ tabId: number; cursor: { x: number; y: number } | null }> = [];
  const downloads: Array<{ tabId: number; url: string; sessionId: string }> = [];
  const visibility: Array<{ tabId: number; visible: boolean }> = [];
  const viewports: Array<{ tabId: number; size: CaptureSurfaceSize | null }> = [];
  let nextTabId = 10;
  let cdpListener: ((event: CdpEvent) => void) | undefined;
  let downloadListener: ((change: BrowserUseDownloadChange) => void) | undefined;

  const driver: CdpDriver = {
    attach: async () => {},
    detach: async () => {},
    onCdpEvent: (listener) => {
      cdpListener = listener;
      return () => {
        cdpListener = undefined;
      };
    },
    onDownloadChange: (listener) => {
      downloadListener = listener;
      return () => {
        downloadListener = undefined;
      };
    },
    sendCommand: async (tabId, method, params, sessionId) => {
      commands.push({ tabId, method, params, sessionId });
      if (method === "Target.attachToTarget") return { sessionId: "child-session-1" };
      if (method === "Runtime.evaluate") return { result: { type: "string", value: "ok" } };
      return {};
    },
    setBrowserUseActive: async () => {},
    setCursor: async (tabId, cursor) => {
      cursors.push({ tabId, cursor });
    },
    allowDownload: async (tabId, url, sessionId) => {
      downloads.push({ tabId, url, sessionId });
    },
    setVisible: async (tabId, visible) => {
      visibility.push({ tabId, visible });
    },
    isVisible: async (tabId) => {
      for (let index = visibility.length - 1; index >= 0; index -= 1) {
        const item = visibility[index]
        if (item?.tabId === tabId) return item.visible
      }
      return false
    },
    setViewport: async (tabId, size) => {
      viewports.push({ tabId, size });
    },
    selectTab: async (tabId) => {
      selected.push(tabId);
      for (const tab of tabs.values()) tab.active = tab.id === tabId;
    },
    listTabs: async () => [...tabs.values()],
    createTab: async (url, owner) => {
      for (const tab of tabs.values()) tab.active = false;
      const tab: BrowserUseTab = {
        id: nextTabId++,
        title: "new",
        url: url ?? "about:blank",
        active: true,
        owner,
      };
      tabs.set(tab.id, tab);
      return tab;
    },
    closeTab: async (tabId) => {
      tabs.delete(tabId);
      closed.push(tabId);
    },
  };

  return {
    driver,
    tabs,
    commands,
    closed,
    selected,
    cursors,
    downloads,
    visibility,
    viewports,
    emitCdp: (event: CdpEvent) => cdpListener?.(event),
    emitDownload: (change: BrowserUseDownloadChange) => downloadListener?.(change),
  };
}

const session = { session_id: "session-a", turn_id: "turn-1" };
const backends: IabBackend[] = [];
const clients: RawClient[] = [];

afterEach(async () => {
  clients.forEach((client) => client.close());
  clients.length = 0;
  await Promise.all(backends.map((backend) => backend.close()));
  backends.length = 0;
});

async function boot() {
  const browser = contractBrowser();
  const socketDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "iab-contract-"));
  const backend = new IabBackend({ driver: browser.driver, socketDir });
  backends.push(backend);
  const socketPath = await backend.listen();
  const client = new RawClient();
  clients.push(client);
  await client.connect(socketPath);
  return {
    ...browser,
    call: (method: string, params: Record<string, unknown>) => client.call(method, params),
    waitForNotification: (method: string) => client.waitForNotification(method),
  };
}

describe("Codex IAB full wire contract", () => {
  it("declares the browser visibility and viewport capabilities", async () => {
    const { call } = await boot();
    const info = (await call("getInfo", session)) as {
      capabilities: { browser: Array<{ id: string }> };
    };
    expect(info.capabilities.browser.map((capability) => capability.id)).toEqual([
      "visibility",
      "viewport",
    ]);
  });

  it("attaches an OOPIF target and routes target commands through its CDP session", async () => {
    const { call, commands } = await boot();
    const tab = (await call("createTab", session)) as BrowserUseTab;

    await call("attachTarget", { ...session, tabId: tab.id, targetId: "frame-target" });
    await call("executeCdp", {
      ...session,
      target: { tabId: tab.id, targetId: "frame-target" },
      method: "Runtime.evaluate",
      commandParams: { expression: "location.href" },
    });
    await call("detachTarget", { ...session, tabId: tab.id, targetId: "frame-target" });

    expect(commands).toContainEqual({
      tabId: tab.id,
      method: "Target.attachToTarget",
      params: { flatten: true, targetId: "frame-target" },
      sessionId: undefined,
    });
    expect(commands).toContainEqual({
      tabId: tab.id,
      method: "Runtime.evaluate",
      params: { expression: "location.href" },
      sessionId: "child-session-1",
    });
    expect(commands).toContainEqual({
      tabId: tab.id,
      method: "Target.detachFromTarget",
      params: { sessionId: "child-session-1" },
      sessionId: undefined,
    });
  });

  it("supports cached Runtime.evaluate expressions and cache misses", async () => {
    const { call, commands } = await boot();
    const tab = (await call("createTab", session)) as BrowserUseTab;
    const target = { tabId: tab.id };

    await expect(
      call("executeCdpWithCachedExpression", {
        ...session,
        target,
        method: "Runtime.evaluate",
        expressionCacheKey: "read-title",
        commandParams: { expression: "document.title", returnByValue: true },
      }),
    ).resolves.toMatchObject({ kind: "executed" });
    await expect(
      call("executeCdpWithCachedExpression", {
        ...session,
        target,
        method: "Runtime.evaluate",
        expressionCacheKey: "read-title",
        commandParams: { returnByValue: true },
      }),
    ).resolves.toMatchObject({ kind: "executed" });
    await expect(
      call("executeCdpWithCachedExpression", {
        ...session,
        target,
        method: "Runtime.evaluate",
        expressionCacheKey: "unknown",
        commandParams: {},
      }),
    ).resolves.toEqual({ kind: "cache-miss" });

    expect(
      commands.filter((command) => command.method === "Runtime.evaluate").map((command) => command.params),
    ).toEqual([
      { expression: "document.title", returnByValue: true },
      { expression: "document.title", returnByValue: true },
    ]);
  });

  it("auto-creates a tab only for targetless Page.navigate", async () => {
    const { call, commands, tabs } = await boot();
    await call("executeCdp", {
      ...session,
      method: "Page.navigate",
      commandParams: { url: "https://example.com" },
    });
    expect([...tabs.values()]).toHaveLength(1);
    expect(commands.at(-1)).toMatchObject({
      tabId: 10,
      method: "Page.navigate",
      params: { url: "https://example.com" },
    });
    await expect(
      call("executeCdp", {
        ...session,
        method: "Runtime.evaluate",
        commandParams: { expression: "1" },
      }),
    ).rejects.toThrow(/requires a tabId target/i);
    await expect(
      call("executeCdp", {
        ...session,
        method: "Page.navigate",
        commandParams: { url: "https://example.org" },
      }),
    ).rejects.toThrow(/requires a tabId target/i);
  });

  it("implements cursor, download grant, visibility and viewport commands", async () => {
    const { call, cursors, downloads, visibility, viewports } = await boot();
    await call("executeUnhandledCommand", {
      ...session,
      type: "browser_visibility_set",
      visible: true,
    });
    await call("executeUnhandledCommand", {
      ...session,
      type: "browser_viewport_set",
      width: 1280,
      height: 800,
    });
    const tab = (await call("createTab", session)) as BrowserUseTab;
    expect(visibility).toEqual([{ tabId: tab.id, visible: true }]);
    expect(viewports).toEqual([{ tabId: tab.id, size: { width: 1280, height: 800 } }]);

    await call("moveMouse", { ...session, tabId: tab.id, x: 25, y: 40, waitForArrival: true });
    await call("allowDownload", {
      ...session,
      tabId: tab.id,
      url: "https://example.com/report.csv",
    });
    await expect(
      call("executeUnhandledCommand", { ...session, type: "browser_visibility_get" }),
    ).resolves.toEqual({ visible: true });
    await call("executeUnhandledCommand", { ...session, type: "browser_viewport_reset" });

    expect(cursors).toContainEqual({ tabId: tab.id, cursor: { x: 25, y: 40 } });
    expect(downloads).toEqual([
      { tabId: tab.id, url: "https://example.com/report.csv", sessionId: "session-a" },
    ]);
    expect(viewports.at(-1)).toEqual({ tabId: tab.id, size: null });
    await expect(
      call("executeUnhandledCommand", {
        ...session,
        type: "tabs_content",
        urls: [],
        content_type: "text",
      }),
    ).resolves.toEqual({ results: [] });
  });

  it("forwards target and download notifications only to the owning session", async () => {
    const { call, emitCdp, emitDownload, waitForNotification } = await boot();
    const tab = (await call("createTab", session)) as BrowserUseTab;
    await call("attachTarget", { ...session, tabId: tab.id, targetId: "frame-target" });

    const cdpNotification = waitForNotification("onCDPEvent");
    emitCdp({
      source: { tabId: tab.id, sessionId: "child-session-1" },
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
    });
    await expect(cdpNotification).resolves.toEqual({
      source: {
        tabId: tab.id,
        sessionId: "child-session-1",
        targetId: "frame-target",
      },
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
    });

    const change: BrowserUseDownloadChange = {
      filename: "/tmp/report.csv",
      id: "download-1",
      session_id: "session-a",
      status: "complete",
      url: "https://example.com/report.csv",
    };
    const downloadNotification = waitForNotification("onDownloadChange");
    emitDownload(change);
    await expect(downloadNotification).resolves.toEqual(change);
  });

  it("turnEnded closes unmarked agent tabs, releases user tabs, and retains handoffs", async () => {
    const { call, tabs, closed } = await boot();
    tabs.set(1, {
      id: 1,
      title: "user",
      url: "https://user.example",
      active: true,
      owner: "session-a",
    });
    await call("claimUserTab", { ...session, tabId: 1 });
    const unmarked = (await call("createTab", session)) as BrowserUseTab;
    const handoff = (await call("createTab", session)) as BrowserUseTab;
    await call("markTab", { ...session, tabId: handoff.id, status: "handoff" });

    await call("turnEnded", session);

    expect(closed).toContain(unmarked.id);
    expect(closed).not.toContain(1);
    expect(closed).not.toContain(handoff.id);
    expect(((await call("getTabs", session)) as BrowserUseTab[]).map((tab) => tab.id)).toEqual([
      handoff.id,
    ]);
    expect(((await call("getUserTabs", session)) as BrowserUseTab[]).map((tab) => tab.id)).toContain(1);
  });
});
