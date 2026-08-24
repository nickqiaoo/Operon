import { describe, expect, it, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IabBackend, type CdpDriver, type BrowserUseTab } from "./IabBackend.ts";
import { encodeFrame, decodeFrames } from "./wire.ts";

/**
 * The tab lease model: the entire basis on which several conversations and the
 * user can share one browser without fighting over it.
 *
 * The finalize rules in full:
 *
 *   let t = keepMap.get(tab.cdpTabId);
 *   if (!(t===`handoff` && tab.origin===`agent`)) {
 *     if (t===`handoff` || t===`deliverable` || tab.origin!==`agent`) { releaseTab(tab); return }
 *     closeTab(tab)
 *   }
 *
 * opened by the agent and never marked, close it; the user's tab, release and
 * never close; marked, release and leave it for the user.
 *
 * These tests speak raw RPC straight over the socket rather than going through a
 * client, because what is under test is the backend's own ledger logic, and a
 * client's high-level API would never produce some of these parameter
 * combinations.
 */

// ---- A minimal raw RPC client ----
class RawClient {
  private sock!: net.Socket;
  // As in JsonRpcPeer: Buffer is generic in recent @types/node, and subarray()
  // returns Buffer<ArrayBufferLike>.
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private seq = 0;
  private readonly pending = new Map<number, (v: { result?: unknown; error?: { message: string } }) => void>();

  async connect(p: string) {
    this.sock = net.createConnection(p);
    await new Promise<void>((res, rej) => {
      this.sock.once("connect", () => res());
      this.sock.once("error", rej);
    });
    this.sock.on("data", (c) => {
      this.buf = Buffer.concat([this.buf, c]);
      const { messages, remainingData } = decodeFrames(this.buf);
      this.buf = remainingData;
      for (const m of messages) {
        const msg = JSON.parse(m) as { id: number; result?: unknown; error?: { message: string } };
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      this.sock.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    });
  }

  close() {
    this.sock.destroy();
  }

  async closeAndWait(): Promise<void> {
    if (this.sock.destroyed) return;
    const closed = new Promise<void>((resolve) => this.sock.once("close", () => resolve()));
    this.sock.destroy();
    await closed;
  }
}

/** A fake browser that remembers which tabs were opened and which were closed. */
function fakeBrowser() {
  // tabId is a number on the wire; see BrowserUseTab.id.
  const tabs = new Map<number, BrowserUseTab>();
  const closed: number[] = [];
  const detached: number[] = [];
  const browserUseActive: Array<{ tabId: number; active: boolean }> = [];
  let next = 100;
  // Two tabs the user opened themselves, in session A's browser panel.
  // `owner` is the conversation whose browser this tab belongs to. The panel
  // switches per conversation, and a page the user opens by hand belongs to
  // whichever conversation is active.
  tabs.set(1, { id: 1, title: "user page", url: "https://user.example", active: true, owner: "sess-A" });
  tabs.set(2, { id: 2, title: "another", url: "https://other.example", active: false, owner: "sess-A" });
  const driver: CdpDriver = {
    attach: async () => {},
    detach: async (id) => {
      detached.push(id);
    },
    setBrowserUseActive: async (tabId, active) => {
      browserUseActive.push({ tabId, active });
    },
    sendCommand: async () => ({}),
    listTabs: async () => [...tabs.values()],
    createTab: async (url, owner) => {
      const id = next++;
      const t = { id, title: "new", url: url ?? "", active: true, owner };
      tabs.set(id, t);
      return t;
    },
    closeTab: async (id) => {
      tabs.delete(id);
      closed.push(id);
    },
  };
  return { driver, tabs, closed, detached, browserUseActive };
}

let backends: IabBackend[] = [];
let clients: RawClient[] = [];
afterEach(async () => {
  clients.forEach((c) => c.close());
  clients = [];
  await Promise.all(backends.map((b) => b.close()));
  backends = [];
});

async function boot() {
  const fake = fakeBrowser();
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lease-"));
  const b = new IabBackend({ driver: fake.driver, socketDir: dir });
  backends.push(b);
  const p = await b.listen();
  const c = new RawClient();
  clients.push(c);
  await c.connect(p);
  return {
    ...fake,
    path: p,
    client: c,
    call: (m: string, params: Record<string, unknown>) => c.call(m, params),
  };
}

async function connectClient(socketPath: string): Promise<RawClient> {
  const client = new RawClient();
  clients.push(client);
  await client.connect(socketPath);
  return client;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const S = { session_id: "sess-A", turn_id: "t1" };
const S2 = { session_id: "sess-B", turn_id: "t1" };

describe("tab ownership", () => {
  it("getUserTabs is what no session holds; getTabs is what this session holds", async () => {
    const { call } = await boot();
    expect(await call("getTabs", S)).toEqual([]); // Nothing leased yet.
    expect((await call("getUserTabs", S)) as unknown[]).toHaveLength(2); // Both user tabs are in the pool.

    await call("claimUserTab", { ...S, tabId: 1 });
    expect(((await call("getTabs", S)) as BrowserUseTab[]).map((t) => t.id)).toEqual([1]);
    expect(((await call("getUserTabs", S)) as BrowserUseTab[]).map((t) => t.id)).toEqual([2]);
  }, 20_000);

  it("a tab from createTab belongs to this session and never appears in the user pool", async () => {
    const { call } = await boot();
    const tab = (await call("createTab", { ...S, url: "https://x.example" })) as BrowserUseTab;
    expect(((await call("getTabs", S)) as BrowserUseTab[]).map((t) => t.id)).toEqual([tab.id]);
    expect(((await call("getUserTabs", S)) as BrowserUseTab[]).map((t) => t.id)).not.toContain(tab.id);
  }, 20_000);

  /**
   * The browser panel switches per conversation, so another conversation's tabs
   * do not exist at all as far as this session is concerned.
   *
   * This is a stronger property than "cannot steal a leased tab": both fake tabs
   * are owned by sess-A, so sess-B cannot even see them. A design with one browser
   * host per conversation gets the same isolation by refusing any tab whose route
   * does not match the session's.
   */
  it("conversations are mutually invisible: B sees no tab from A's browser, leased or not", async () => {
    const { call } = await boot();
    await call("claimUserTab", { ...S, tabId: 1 });

    expect((await call("getTabs", S2)) as BrowserUseTab[]).toEqual([]);
    // Tab 2 is leased by nobody, but it lives in A's panel, so it must not be in
    // B's pool either.
    expect((await call("getUserTabs", S2)) as BrowserUseTab[]).toEqual([]);
    await expect(call("claimUserTab", { ...S2, tabId: 2 })).rejects.toThrow(
      /not part of this browser session/i,
    );
    // And one A holds is even further out of reach.
    await expect(call("claimUserTab", { ...S2, tabId: 1 })).rejects.toThrow(
      /not part of this browser session/i,
    );
  }, 20_000);

  /** Within one conversation: a tab this session has leased leaves the user pool. */
  it("after A leases tab 1, A's own pool holds only tab 2", async () => {
    const { call } = await boot();
    await call("claimUserTab", { ...S, tabId: 1 });
    expect(((await call("getUserTabs", S)) as BrowserUseTab[]).map((t) => t.id)).toEqual([2]);
  }, 20_000);
});

describe("the ownership gate on driving operations (requireLeased)", () => {
  /**
   * This guards the most important property. `getTabs` and `claimUserTab` check
   * ownership, but if `attach`, `detach` and `executeCdp` do not, naming a tabId
   * is enough to drive any tab at all. And tabId is `webContents.id`: a small
   * integer.
   */
  it("executeCdp without a lease is refused, even for a tab that exists", async () => {
    const { call } = await boot();
    await expect(
      call("executeCdp", { ...S, target: { tabId: 1 }, method: "Runtime.evaluate", commandParams: {} }),
    ).rejects.toThrow(/not part of this browser session/i);
  }, 20_000);

  it("attach and detach without a lease are refused", async () => {
    const { call } = await boot();
    await expect(call("attach", { ...S, tabId: 1 })).rejects.toThrow(/not part of this browser session/i);
    await expect(call("detach", { ...S, tabId: 1 })).rejects.toThrow(/not part of this browser session/i);
  }, 20_000);

  it("permitted once leased", async () => {
    const { call } = await boot();
    await call("claimUserTab", { ...S, tabId: 1 });
    await expect(call("attach", { ...S, tabId: 1 })).resolves.toBeNull();
    await expect(
      call("executeCdp", { ...S, target: { tabId: 1 }, method: "Runtime.evaluate", commandParams: {} }),
    ).resolves.toBeDefined();
  }, 20_000);

  it("B cannot drive a tab A holds", async () => {
    const { call } = await boot();
    await call("claimUserTab", { ...S, tabId: 1 });
    await expect(
      call("executeCdp", { ...S2, target: { tabId: 1 }, method: "Runtime.evaluate", commandParams: {} }),
    ).rejects.toThrow(/not part of this browser session/i);
  }, 20_000);
});

describe("finalizeTabs", () => {
  it("opened by the agent and unmarked: closed", async () => {
    const { call, closed } = await boot();
    const tab = (await call("createTab", S)) as BrowserUseTab;
    await call("finalizeTabs", { ...S, keep: [] });
    expect(closed).toEqual([tab.id]);
  }, 20_000);

  it("opened by the agent and marked deliverable in keep: released, not closed", async () => {
    const { call, closed } = await boot();
    const tab = (await call("createTab", S)) as BrowserUseTab;
    await call("finalizeTabs", { ...S, keep: [{ tabId: tab.id, status: "deliverable" }] });
    expect(closed).toEqual([]);
    // Released back into the user pool.
    expect(((await call("getUserTabs", S)) as BrowserUseTab[]).map((t) => t.id)).toContain(tab.id);
  }, 20_000);

  it("a user's tab is never closed, even when absent from keep", async () => {
    const { call, closed } = await boot();
    await call("claimUserTab", { ...S, tabId: 1 });
    await call("finalizeTabs", { ...S, keep: [] });
    expect(closed).toEqual([]); // origin is not "agent", so release only.
    expect(((await call("getUserTabs", S)) as BrowserUseTab[]).map((t) => t.id)).toContain(1);
  }, 20_000);

  it("after finalize this session holds no tabs", async () => {
    const { call } = await boot();
    await call("claimUserTab", { ...S, tabId: 1 });
    await call("createTab", S);
    await call("finalizeTabs", { ...S, keep: [] });
    expect(await call("getTabs", S)).toEqual([]);
  }, 20_000);

  it("a non-array keep raises the expected error", async () => {
    const { call } = await boot();
    await expect(call("finalizeTabs", { ...S, keep: "nope" })).rejects.toThrow(/keep array/i);
  }, 20_000);
});

describe("closeTab", () => {
  it("a tab the agent created is genuinely closed and its lease released", async () => {
    const { call, closed } = await boot();
    const tab = (await call("createTab", S)) as BrowserUseTab;
    await call("closeTab", { ...S, tabId: tab.id });
    expect(closed).toEqual([tab.id]);
    expect(await call("getTabs", S)).toEqual([]);
  }, 20_000);

  it("a user tab is released, never destroyed", async () => {
    const { call, closed } = await boot();
    await call("claimUserTab", { ...S, tabId: 1 });
    await call("closeTab", { ...S, tabId: 1 });
    expect(closed).toEqual([]);
    expect(((await call("getUserTabs", S)) as BrowserUseTab[]).map((tab) => tab.id)).toContain(1);
  }, 20_000);
});

describe("a dropped socket releases orphaned leases", () => {
  it("the last connection dropping releases without closing, so a new kernel can reclaim", async () => {
    const { call, client, path: socketPath, closed, detached, browserUseActive } = await boot();
    const tab = (await call("createTab", S)) as BrowserUseTab;
    expect(browserUseActive).toEqual([{ tabId: tab.id, active: true }]);

    await client.closeAndWait();
    // Use detach as the signal that the server has processed the close, which
    // avoids racing a new connection against the old close callback.
    await waitUntil(() => detached.includes(tab.id));
    expect(closed).toEqual([]);
    await waitUntil(() => browserUseActive.some((entry) => entry.tabId === tab.id && !entry.active));

    const restartedKernel = await connectClient(socketPath);
    expect(((await restartedKernel.call("getUserTabs", S)) as BrowserUseTab[]).map((t) => t.id)).toContain(tab.id);
    await expect(restartedKernel.call("claimUserTab", { ...S, tabId: tab.id })).resolves.toMatchObject({
      id: tab.id,
    });
  }, 20_000);

  it("nothing is released while the session has other connections; only the last one triggers it", async () => {
    const { call, client: first, path: socketPath, detached } = await boot();
    const second = await connectClient(socketPath);
    // Make the backend record that the second connection is also sess-A's.
    await second.call("getInfo", S);
    const tab = (await call("createTab", S)) as BrowserUseTab;

    await first.closeAndWait();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(detached).not.toContain(tab.id);
    expect(((await second.call("getTabs", S)) as BrowserUseTab[]).map((t) => t.id)).toContain(tab.id);

    await second.closeAndWait();
    await waitUntil(() => detached.includes(tab.id));
    const restartedKernel = await connectClient(socketPath);
    expect(((await restartedKernel.call("getUserTabs", S)) as BrowserUseTab[]).map((t) => t.id)).toContain(tab.id);
  }, 20_000);

  it("a reconnect waits for the old paint-host teardown, so active:false cannot overwrite a reclaim", async () => {
    const { call, client, path: socketPath, driver, detached, browserUseActive } = await boot();
    const tab = (await call("createTab", S)) as BrowserUseTab;
    const originalSetActive = driver.setBrowserUseActive?.bind(driver);
    let finishDeactivate = () => {};
    const deactivateGate = new Promise<void>((resolve) => {
      finishDeactivate = resolve;
    });
    driver.setBrowserUseActive = async (tabId, active) => {
      if (!active) await deactivateGate;
      await originalSetActive?.(tabId, active);
    };

    await client.closeAndWait();
    await waitUntil(() => detached.includes(tab.id));
    const restartedKernel = await connectClient(socketPath);
    let querySettled = false;
    const userTabs = restartedKernel.call("getUserTabs", S).finally(() => {
      querySettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(querySettled).toBe(false);

    finishDeactivate();
    expect(((await userTabs) as BrowserUseTab[]).map((entry) => entry.id)).toContain(tab.id);
    expect(browserUseActive.at(-1)).toEqual({ tabId: tab.id, active: false });
    await restartedKernel.call("claimUserTab", { ...S, tabId: tab.id });
    expect(browserUseActive.at(-1)).toEqual({ tabId: tab.id, active: true });
  }, 20_000);
});

describe("markTab", () => {
  it("a marked tab is finalized by its mark, without needing to be in keep", async () => {
    const { call, closed } = await boot();
    const tab = (await call("createTab", S)) as BrowserUseTab;
    await call("markTab", { ...S, tabId: tab.id, status: "deliverable" });
    await call("finalizeTabs", { ...S, keep: [] });
    expect(closed).toEqual([]);
  }, 20_000);

  it("status accepts only handoff and deliverable", async () => {
    const { call } = await boot();
    const tab = (await call("createTab", S)) as BrowserUseTab;
    await expect(call("markTab", { ...S, tabId: tab.id, status: "bogus" })).rejects.toThrow(/handoff/);
  }, 20_000);

  it("marking a tab this session does not hold is refused", async () => {
    const { call } = await boot();
    await expect(call("markTab", { ...S, tabId: 1, status: "handoff" })).rejects.toThrow(
      /not part of this browser session/i,
    );
  }, 20_000);
});

describe("session_id is required", () => {
  it("every session method raises the expected error without a session_id", async () => {
    const { call } = await boot();
    for (const m of ["getTabs", "getUserTabs", "createTab", "finalizeTabs"]) {
      await expect(call(m, {}), `${m} should require session_id`).rejects.toThrow(
        /Missing required browser session_id/,
      );
    }
  }, 20_000);

  it("the IAB backend does not support history and throws", async () => {
    const { call } = await boot();
    await expect(call("getUserHistory", S)).rejects.toThrow(/not available/i);
  }, 20_000);
});
