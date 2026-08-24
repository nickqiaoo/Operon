/**
 * Tests for the forked Chrome backend, loaded into a vm sandbox with a fake chrome.*.
 *
 * Scope is deliberately the fork's own diff — the handshake, the three added wire methods,
 * and the turnEnded disposition — not upstream behavior we inherited unchanged. The sandbox
 * approach follows upstream's own test harness: background.js is a service worker with no
 * exports, so we append an assignment and read the class back out of the context.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const BG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "background.js");

type TabStatus = "handoff" | "deliverable";
type TabOrigin = "agent" | "user";

interface FakeTab {
  id: number;
  windowId: number;
  groupId: number;
  url?: string;
}
interface FakeGroup {
  id: number;
  windowId: number;
  title: string;
}
interface SentCommand {
  target: Record<string, unknown>;
  method: string;
  params: unknown;
}

/** Only the surface these tests drive; the backend has many more RPC methods. */
interface Backend {
  store: {
    getSession(sessionId: string): Promise<{
      chromeGroupId: number | null;
      tabOrigins: Record<string, TabOrigin>;
      tabMarks: Record<string, { status: TabStatus; turnId: string }>;
      activeTabId: number | null;
    }>;
    save(): Promise<void>;
  };
  attachedTabs: Set<number>;
  getInfo(params?: unknown): Promise<Record<string, unknown>>;
  attachTarget(params: unknown): Promise<void>;
  detachTarget(params: unknown): Promise<void>;
  markTab(params: unknown): Promise<void>;
  turnEnded(params: unknown): Promise<void>;
  finalizeTabs(params: unknown): Promise<void>;
  closeTab(params: unknown): Promise<void>;
  executeCdp(params: unknown): Promise<unknown>;
}

function createChromeFake() {
  const state = {
    nextTabId: 1000,
    nextGroupId: 100,
    nextSessionId: 1,
    tabs: new Map<number, FakeTab>(),
    groups: new Map<number, FakeGroup>(),
    attached: new Set<number>(),
    storage: {} as Record<string, unknown>,
    sent: [] as SentCommand[],
  };

  const disposeEmptyGroups = () => {
    for (const [gid] of state.groups) {
      if (![...state.tabs.values()].some((t) => t.groupId === gid)) state.groups.delete(gid);
    }
  };

  // Frames the extension posts to the native host, and every chrome.debugger.onDetach
  // listener registered — the two things the onCDPDetach forwarding path touches.
  const nativePosts: unknown[] = [];
  const detachListeners: Array<(source: { tabId?: number }) => void> = [];
  // Reconnect bookkeeping: one entry per connectNative (i.e. per host Chrome would spawn), the
  // live port's onDisconnect so a test can kill the host, and the alarm calls.
  const nativeConnects: string[] = [];
  const disconnectListeners: Array<() => void> = [];
  const alarmsCreated: Array<{ name: string; info: unknown }> = [];
  const alarmsCleared: string[] = [];

  const chrome = {
    runtime: {
      id: "operontestextensionidaaaaaaaaaaaa",
      getManifest: () => ({ version: "0.1.0" }),
      connectNative: (hostName: string) => {
        nativeConnects.push(hostName);
        return {
          onMessage: { addListener() {} },
          onDisconnect: {
            addListener(callback: () => void) {
              disconnectListeners.push(callback);
            },
          },
          postMessage(message: unknown) {
            nativePosts.push(message);
          },
          disconnect() {},
        };
      },
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        async get(key: string) {
          return key in state.storage ? { [key]: state.storage[key] } : {};
        },
        async set(obj: Record<string, unknown>) {
          Object.assign(state.storage, obj);
        },
      },
    },
    tabs: {
      async get(tabId: number) {
        const tab = state.tabs.get(tabId);
        if (!tab) throw new Error(`No tab ${tabId}`);
        return { ...tab };
      },
      async query(filter?: { groupId?: number }) {
        return [...state.tabs.values()]
          .filter((t) => filter?.groupId == null || t.groupId === filter.groupId)
          .map((t) => ({ ...t }));
      },
      async remove(tabIds: number | number[]) {
        for (const id of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          state.tabs.delete(id);
          state.attached.delete(id); // Chrome auto-detaches when a tab closes.
        }
        disposeEmptyGroups();
      },
      async group({ groupId, tabIds }: { groupId?: number; tabIds: number | number[] }) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        let target = groupId;
        if (typeof target !== "number") {
          target = state.nextGroupId++;
          state.groups.set(target, {
            id: target,
            windowId: state.tabs.get(ids[0])?.windowId ?? 1,
            title: "",
          });
        } else if (!state.groups.has(target)) {
          throw new Error(`No group ${target}`);
        }
        for (const id of ids) {
          const tab = state.tabs.get(id);
          if (tab) tab.groupId = target;
        }
        disposeEmptyGroups();
        return target;
      },
      async ungroup(tabIds: number | number[]) {
        for (const id of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          const tab = state.tabs.get(id);
          if (tab) tab.groupId = -1;
        }
        disposeEmptyGroups();
      },
      // No content script in a sandbox; the backend treats this as "cursor unavailable".
      async sendMessage() {
        throw new Error("no receiver");
      },
    },
    tabGroups: {
      async get(groupId: number) {
        const group = state.groups.get(groupId);
        if (!group) throw new Error(`No group ${groupId}`);
        return { ...group };
      },
      async query(filter?: { windowId?: number; title?: string }) {
        return [...state.groups.values()]
          .filter(
            (g) =>
              (filter?.windowId == null || g.windowId === filter.windowId) &&
              (filter?.title == null || g.title === filter.title),
          )
          .map((g) => ({ ...g }));
      },
      async update(groupId: number, patch: Partial<FakeGroup>) {
        const group = state.groups.get(groupId);
        if (group) Object.assign(group, patch);
        return group ? { ...group } : {};
      },
    },
    debugger: {
      async attach({ tabId }: { tabId: number }) {
        state.attached.add(tabId);
      },
      async detach({ tabId }: { tabId: number }) {
        if (!state.attached.has(tabId)) throw new Error(`Debugger is not attached to tab ${tabId}`);
        state.attached.delete(tabId);
      },
      async sendCommand(target: Record<string, unknown>, method: string, params: unknown) {
        state.sent.push({ target, method, params });
        if (method === "Target.attachToTarget") return { sessionId: `cdp-${state.nextSessionId++}` };
        return {};
      },
      async getTargets() {
        return [];
      },
      onEvent: { addListener() {} },
      onDetach: {
        addListener(listener: (source: { tabId?: number }) => void) {
          detachListeners.push(listener);
        },
      },
    },
    scripting: {
      async executeScript() {
        return [];
      },
    },
    alarms: {
      create: async (name: string, info: unknown) => {
        alarmsCreated.push({ name, info });
      },
      clear: async (name: string) => {
        alarmsCleared.push(name);
        return true;
      },
      onAlarm: { addListener() {} },
    },
    windows: {
      async getAll() {
        return [{ id: 1, focused: true }];
      },
    },
    downloads: { onCreated: { addListener() {} }, onChanged: { addListener() {} } },
  };

  const addTab = ({ windowId = 1, groupId = -1 }: { windowId?: number; groupId?: number } = {}) => {
    const id = state.nextTabId++;
    state.tabs.set(id, { id, windowId, groupId });
    return id;
  };
  const addGroup = ({ windowId = 1, title = "Operon Task" } = {}) => {
    const id = state.nextGroupId++;
    state.groups.set(id, { id, windowId, title });
    return id;
  };

  /** What Chrome does when the host exits: the live port's onDisconnect fires. */
  const killHost = () => disconnectListeners.pop()?.();

  return {
    chrome,
    state,
    addTab,
    addGroup,
    nativePosts,
    detachListeners,
    nativeConnects,
    alarmsCreated,
    alarmsCleared,
    killHost,
  };
}

let bgSource: string;
beforeAll(async () => {
  bgSource = await readFile(BG_PATH, "utf8");
});

function loadBackend(chromeFake: unknown): Backend {
  const context = vm.createContext({
    chrome: chromeFake,
    console,
    setTimeout,
    clearTimeout,
    crypto: globalThis.crypto,
    Date,
  });
  // background.js is a service worker: no exports, so hand the class out via the context.
  vm.runInContext(`${bgSource}\nglobalThis.__Backend = BrowserBackend;`, context);
  return new (context as { __Backend: new () => Backend }).__Backend();
}

/**
 * The transport the service worker actually wires up at load, rather than a fresh instance:
 * reconnect is top-level behavior, so testing the real one keeps the wiring in scope.
 */
function loadTransport(chromeFake: unknown): unknown {
  const context = vm.createContext({
    chrome: chromeFake,
    console,
    setTimeout,
    clearTimeout,
    crypto: globalThis.crypto,
    Date,
  });
  vm.runInContext(`${bgSource}\nglobalThis.__transport = transport;`, context);
  return (context as { __transport: unknown }).__transport;
}

/**
 * Put a live session into the store directly. Going through createTab/claimUserTab would
 * work too but would couple every test to that path's own behavior.
 */
async function seedSession(
  backend: Backend,
  {
    sessionId,
    groupId,
    tabOrigins,
    attached = [],
  }: {
    sessionId: string;
    groupId: number;
    tabOrigins: Record<number, TabOrigin>;
    attached?: number[];
  },
) {
  const session = await backend.store.getSession(sessionId);
  session.chromeGroupId = groupId;
  session.tabOrigins = Object.fromEntries(
    Object.entries(tabOrigins).map(([id, origin]) => [id, origin]),
  );
  await backend.store.save();
  for (const tabId of attached) backend.attachedTabs.add(tabId);
}

describe("getInfo", () => {
  it("returns a handshake the official client's schema accepts", async () => {
    // Upstream returns {name, version, type, metadata} — missing `id` and `capabilities`,
    // which the schema requires. That rejection, not any missing method, is the reason the
    // published upstream extension cannot be used as-is.
    const { chrome } = createChromeFake();
    const info = await loadBackend(chrome).getInfo({ session_id: "s1", turn_id: "t1" });

    expect(typeof info.id).toBe("string");
    expect(info.id).not.toBe("");
    expect(info.name).toBe("Operon Chrome");
    expect(info.type).toBe("extension");
    expect(info.capabilities).toBeDefined();
  });

  it("does not claim an app build flavor", async () => {
    const { chrome } = createChromeFake();
    const info = await loadBackend(chrome).getInfo({ session_id: "s1", turn_id: "t1" });
    expect(info.metadata).not.toHaveProperty("operonBuildFlavor");
  });

  it("echoes the asking session back so one backend serves every session", async () => {
    const { chrome } = createChromeFake();
    const backend = loadBackend(chrome);
    const first = await backend.getInfo({ session_id: "session-a", turn_id: "t1" });
    const second = await backend.getInfo({ session_id: "session-b", turn_id: "t1" });

    expect((first.metadata as Record<string, string>).operonSessionId).toBe("session-a");
    expect((second.metadata as Record<string, string>).operonSessionId).toBe("session-b");
    // Same backend identity both times: only the echoed session differs.
    expect(second.id).toBe(first.id);
  });

  it("keeps every metadata value a string, as record(string) requires", async () => {
    const { chrome } = createChromeFake();
    const info = await loadBackend(chrome).getInfo({ session_id: "s1", turn_id: "t1" });
    for (const value of Object.values(info.metadata as Record<string, unknown>)) {
      expect(typeof value).toBe("string");
    }
  });
});

describe("markTab", () => {
  it("rejects a status outside the official vocabulary", async () => {
    const { chrome, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, { sessionId: "s1", groupId, tabOrigins: { [tabId]: "agent" } });

    await expect(
      backend.markTab({ session_id: "s1", turn_id: "t1", tabId, status: "keep" }),
    ).rejects.toThrow(/invalid status/);
  });

  it("records the marking turn, and the latest mark wins", async () => {
    const { chrome, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, { sessionId: "s1", groupId, tabOrigins: { [tabId]: "agent" } });

    await backend.markTab({ session_id: "s1", turn_id: "t1", tabId, status: "handoff" });
    await backend.markTab({ session_id: "s1", turn_id: "t1", tabId, status: "deliverable" });

    const session = await backend.store.getSession("s1");
    expect(session.tabMarks[String(tabId)]).toEqual({ status: "deliverable", turnId: "t1" });
  });
});

describe("turnEnded", () => {
  it("closes unmarked agent tabs and keeps marked ones", async () => {
    // Upstream only detached here, which leaks every agent tab under the mark flow —
    // "agent-created tabs are ephemeral and close automatically unless you mark them".
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const unmarked = addTab({ groupId });
    const handoff = addTab({ groupId });
    const deliverable = addTab({ groupId });
    await seedSession(backend, {
      sessionId: "s1",
      groupId,
      tabOrigins: { [unmarked]: "agent", [handoff]: "agent", [deliverable]: "agent" },
      attached: [unmarked, handoff, deliverable],
    });
    for (const tabId of [unmarked, handoff, deliverable]) state.attached.add(tabId);

    await backend.markTab({ session_id: "s1", turn_id: "t1", tabId: handoff, status: "handoff" });
    await backend.markTab({
      session_id: "s1",
      turn_id: "t1",
      tabId: deliverable,
      status: "deliverable",
    });
    await backend.turnEnded({ session_id: "s1", turn_id: "t1" });

    expect(state.tabs.has(unmarked)).toBe(false);
    expect(state.tabs.has(handoff)).toBe(true);
    expect(state.tabs.has(deliverable)).toBe(true);
  });

  it("moves deliverables into the deliverable group", async () => {
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const deliverable = addTab({ groupId });
    await seedSession(backend, {
      sessionId: "s1",
      groupId,
      tabOrigins: { [deliverable]: "agent" },
      attached: [deliverable],
    });
    state.attached.add(deliverable);

    await backend.markTab({
      session_id: "s1",
      turn_id: "t1",
      tabId: deliverable,
      status: "deliverable",
    });
    await backend.turnEnded({ session_id: "s1", turn_id: "t1" });

    const landed = state.tabs.get(deliverable);
    expect(landed).toBeDefined();
    expect(state.groups.get(landed!.groupId)?.title).toBe("✅ Operon");
  });

  it("releases claimed user tabs instead of closing them", async () => {
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const userTab = addTab({ groupId });
    await seedSession(backend, {
      sessionId: "s1",
      groupId,
      tabOrigins: { [userTab]: "user" },
      attached: [userTab],
    });
    state.attached.add(userTab);

    await backend.turnEnded({ session_id: "s1", turn_id: "t1" });

    expect(state.tabs.has(userTab)).toBe(true);
    expect(state.tabs.get(userTab)?.groupId).toBe(-1);
  });

  it("ignores a mark left behind by an earlier turn", async () => {
    // Marks are turn-scoped: a handoff tab must be marked again each turn it should survive.
    // Without the turn check a single mark would keep a tab alive forever.
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, {
      sessionId: "s1",
      groupId,
      tabOrigins: { [tabId]: "agent" },
      attached: [tabId],
    });
    state.attached.add(tabId);

    await backend.markTab({ session_id: "s1", turn_id: "t1", tabId, status: "handoff" });
    await backend.turnEnded({ session_id: "s1", turn_id: "t2" });

    expect(state.tabs.has(tabId)).toBe(false);
  });

  it("detaches the debugger so Chrome's banner clears", async () => {
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, {
      sessionId: "s1",
      groupId,
      tabOrigins: { [tabId]: "agent" },
      attached: [tabId],
    });
    state.attached.add(tabId);

    await backend.markTab({ session_id: "s1", turn_id: "t1", tabId, status: "handoff" });
    await backend.turnEnded({ session_id: "s1", turn_id: "t1" });

    expect(state.attached.has(tabId)).toBe(false);
  });

  it("does not re-dispose tabs that finalizeTabs already kept this turn", async () => {
    // finalize keeps the session alive when it retains a handoff tab, so "did the session
    // survive" cannot tell us whether finalize ran — turnEnded would then close the very tab
    // finalize just saved. The turn it was finalized in is what actually answers that.
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const agentTab = addTab({ groupId });
    const keptTab = addTab({ groupId });
    await seedSession(backend, {
      sessionId: "s1",
      groupId,
      tabOrigins: { [agentTab]: "agent", [keptTab]: "agent" },
      attached: [agentTab, keptTab],
    });
    state.attached.add(agentTab);
    state.attached.add(keptTab);

    await backend.finalizeTabs({
      session_id: "s1",
      turn_id: "t1",
      keep: [{ tabId: keptTab, status: "handoff" }],
    });
    await backend.turnEnded({ session_id: "s1", turn_id: "t1" });

    expect(state.tabs.has(agentTab)).toBe(false);
    expect(state.tabs.has(keptTab)).toBe(true);
  });

  it("lets an explicit finalize override an earlier mark", async () => {
    // finalize's keep list speaks for the end of the turn; a mark speaks for the middle of
    // it. Omission from keep is an instruction to close, not an absence of one.
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, {
      sessionId: "s1",
      groupId,
      tabOrigins: { [tabId]: "agent" },
      attached: [tabId],
    });
    state.attached.add(tabId);

    await backend.markTab({ session_id: "s1", turn_id: "t1", tabId, status: "handoff" });
    await backend.finalizeTabs({ session_id: "s1", turn_id: "t1", keep: [] });

    expect(state.tabs.has(tabId)).toBe(false);
  });
});

describe("closeTab", () => {
  it("closes agent-created tabs and clears debugger/session state", async () => {
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, {
      sessionId: "s1",
      groupId,
      tabOrigins: { [tabId]: "agent" },
      attached: [tabId],
    });
    state.attached.add(tabId);

    await backend.closeTab({ session_id: "s1", turn_id: "t1", tabId });

    expect(state.tabs.has(tabId)).toBe(false);
    expect(state.attached.has(tabId)).toBe(false);
    const session = await backend.store.getSession("s1");
    expect(session.tabOrigins[String(tabId)]).toBeUndefined();
  });

  it("releases claimed user tabs without closing them", async () => {
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, {
      sessionId: "s1",
      groupId,
      tabOrigins: { [tabId]: "user" },
    });

    await backend.closeTab({ session_id: "s1", turn_id: "t1", tabId });

    expect(state.tabs.get(tabId)?.groupId).toBe(-1);
    const session = await backend.store.getSession("s1");
    expect(session.tabOrigins[String(tabId)]).toBeUndefined();
  });
});

describe("attachTarget", () => {
  it("opens a flattened CDP session for the target", async () => {
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, { sessionId: "s1", groupId, tabOrigins: { [tabId]: "agent" } });

    await backend.attachTarget({ session_id: "s1", turn_id: "t1", tabId, targetId: "TARGET-1" });

    const attach = state.sent.find((c) => c.method === "Target.attachToTarget");
    expect(attach?.params).toEqual({ targetId: "TARGET-1", flatten: true });
  });

  it("is idempotent: a second attach for the same target reuses the session", async () => {
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, { sessionId: "s1", groupId, tabOrigins: { [tabId]: "agent" } });

    const params = { session_id: "s1", turn_id: "t1", tabId, targetId: "TARGET-1" };
    await backend.attachTarget(params);
    await backend.attachTarget(params);

    expect(state.sent.filter((c) => c.method === "Target.attachToTarget")).toHaveLength(1);
  });

  it("rejects a missing targetId", async () => {
    const { chrome, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, { sessionId: "s1", groupId, tabOrigins: { [tabId]: "agent" } });

    await expect(
      backend.attachTarget({ session_id: "s1", turn_id: "t1", tabId }),
    ).rejects.toThrow(/targetId/);
  });

  it("routes a later executeCdp by sessionId, not targetId", async () => {
    // chrome.debugger dispatches on sessionId. The client sends {tabId, targetId} whenever
    // it did not observe Target.attachedToTarget, so without this translation its documented
    // fallback path would never reach the frame.
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, {
      sessionId: "s1",
      groupId,
      tabOrigins: { [tabId]: "agent" },
      attached: [tabId],
    });

    await backend.attachTarget({ session_id: "s1", turn_id: "t1", tabId, targetId: "TARGET-1" });
    await backend.executeCdp({
      session_id: "s1",
      turn_id: "t1",
      target: { tabId, targetId: "TARGET-1" },
      method: "Runtime.evaluate",
      commandParams: { expression: "1" },
    });

    const evaluate = state.sent.find((c) => c.method === "Runtime.evaluate");
    expect(evaluate?.target).toEqual({ tabId, sessionId: "cdp-1" });
  });

  it("refuses a target that was never attached", async () => {
    const { chrome, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, {
      sessionId: "s1",
      groupId,
      tabOrigins: { [tabId]: "agent" },
      attached: [tabId],
    });

    await expect(
      backend.executeCdp({
        session_id: "s1",
        turn_id: "t1",
        target: { tabId, targetId: "GHOST" },
        method: "Runtime.evaluate",
      }),
    ).rejects.toThrow(/No debugger session is attached/);
  });
});

describe("detachTarget", () => {
  it("closes the CDP session it opened", async () => {
    const { chrome, state, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, { sessionId: "s1", groupId, tabOrigins: { [tabId]: "agent" } });

    await backend.attachTarget({ session_id: "s1", turn_id: "t1", tabId, targetId: "TARGET-1" });
    await backend.detachTarget({ session_id: "s1", turn_id: "t1", tabId, targetId: "TARGET-1" });

    const detach = state.sent.find((c) => c.method === "Target.detachFromTarget");
    expect(detach?.params).toEqual({ sessionId: "cdp-1" });
  });

  it("resolves quietly for an unknown target", async () => {
    // The client detaches every remembered frame target on teardown, after a tab-level
    // detach already dropped them all. Throwing here would only manufacture noise.
    const { chrome, addTab, addGroup } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, { sessionId: "s1", groupId, tabOrigins: { [tabId]: "agent" } });

    await expect(
      backend.detachTarget({ session_id: "s1", turn_id: "t1", tabId, targetId: "GHOST" }),
    ).resolves.toBeUndefined();
  });
});

describe("chrome.debugger.onDetach", () => {
  it("tells the client to forget a tab Chrome detached out from under us", async () => {
    // The official extension forwards this; upstream (obu) dropped it. Without it, an
    // external detach — DevTools opened, another debugger, a crash — leaves the client
    // sending CDP to a dead attachment for the rest of the turn, because it was never told
    // to re-attach. The client reads source.tabId, so the raw source must go through.
    const fake = createChromeFake();
    loadBackend(fake.chrome);

    for (const fire of fake.detachListeners) fire({ tabId: 4242 });

    const detachNote = fake.nativePosts.find(
      (m): m is { method: string; params: { tabId: number } } =>
        typeof m === "object" && m !== null && (m as { method?: unknown }).method === "onCDPDetach",
    );
    expect(detachNote).toBeDefined();
    expect(detachNote?.params.tabId).toBe(4242);
  });

  it("drops the tab's target sessions so a later attachTarget re-attaches", async () => {
    // The tab-level detach kills every CDP session under it. If the backend keeps the
    // remembered target session, the next attachTarget short-circuits and hands the client
    // a sessionId Chrome has already forgotten.
    const { chrome, state, addTab, addGroup, detachListeners } = createChromeFake();
    const backend = loadBackend(chrome);
    const groupId = addGroup();
    const tabId = addTab({ groupId });
    await seedSession(backend, {
      sessionId: "s1",
      groupId,
      tabOrigins: { [tabId]: "agent" },
      attached: [tabId],
    });

    await backend.attachTarget({ session_id: "s1", turn_id: "t1", tabId, targetId: "T1" });
    for (const fire of detachListeners) fire({ tabId });
    await backend.attachTarget({ session_id: "s1", turn_id: "t1", tabId, targetId: "T1" });

    // Two real attaches, not one attach plus a short-circuit onto a dead session.
    expect(state.sent.filter((c) => c.method === "Target.attachToTarget")).toHaveLength(2);
  });
});

/**
 * Reconnect is the only way the native host ever comes back. Nothing on the agent side can ask
 * for it: the client discovers backends by scanning a socket directory, so it has no channel to
 * this extension, and a `browsers.get("chrome")` landing while the host is down fails outright.
 * The window is not hypothetical — in dev the vite server SIGKILLs the host on every rebuild.
 */
describe("native host reconnect", () => {
  beforeEach(() => {
    // Installed before createContext so the vm captures the fake timers and Date, not the real ones.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("brings the host back on its own after it dies", () => {
    const { chrome, nativeConnects, killHost } = createChromeFake();
    loadTransport(chrome);
    expect(nativeConnects).toHaveLength(1);

    killHost();
    expect(nativeConnects).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(nativeConnects).toHaveLength(2);
  });

  it("backs off a host that dies on arrival rather than respawning it every second", () => {
    const { chrome, nativeConnects, killHost } = createChromeFake();
    loadTransport(chrome);

    killHost();
    vi.advanceTimersByTime(1_000);
    expect(nativeConnects).toHaveLength(2);

    killHost();
    vi.advanceTimersByTime(1_000);
    expect(nativeConnects).toHaveLength(2); // 1s no longer buys a retry
    vi.advanceTimersByTime(1_000);
    expect(nativeConnects).toHaveLength(3); // 2s does
  });

  it("retries fast again after a connection that lasted", () => {
    const { chrome, nativeConnects, killHost } = createChromeFake();
    loadTransport(chrome);
    killHost();
    vi.advanceTimersByTime(1_000);
    killHost();
    vi.advanceTimersByTime(2_000);
    expect(nativeConnects).toHaveLength(3);

    // This one sticks around, so its death is not the host flapping: the backoff starts over.
    vi.advanceTimersByTime(10_000);
    killHost();
    vi.advanceTimersByTime(1_000);
    expect(nativeConnects).toHaveLength(4);
  });

  it("arms the eviction backstop only while down", () => {
    const { chrome, alarmsCreated, alarmsCleared, killHost } = createChromeFake();
    loadTransport(chrome);
    // Connected on load: the periodic alarm would otherwise keep firing for the whole session.
    expect(alarmsCleared).toContain("operon-browser-use-native-reconnect");

    killHost();
    const armed = alarmsCreated.filter((a) => a.name === "operon-browser-use-native-reconnect");
    // 0.5 is Chrome's real floor for a periodic alarm — the old 0.1 silently became this anyway.
    expect(armed.at(-1)?.info).toEqual({ periodInMinutes: 0.5 });
  });
});
