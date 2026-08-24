/**
 * Operon Browser Use — Chrome backend.
 *
 * Forked from open-browser-use (MIT, Copyright (c) 2026 Leo) at 07a8014.
 * See NOTICE.md for what we changed and why we could not use the upstream build.
 *
 * This service worker *is* the backend: the client SDK talks the Operon Browser Use
 * wire protocol to a native host, which relays frames here over Chrome native
 * messaging. Every method on BrowserBackend is an RPC entry point.
 */
const NATIVE_HOST_NAME = "com.operon.browser_use.extension";
const NATIVE_HOST_STATUS_KEY = "OPERON_BROWSER_USE_NATIVE_HOST_STATUS";
const SESSION_STATE_KEY = "OPERON_BROWSER_USE_SESSION_STATE";
const RECONNECT_ALARM_NAME = "operon-browser-use-native-reconnect";
const HEARTBEAT_ALARM_NAME = "operon-browser-use-heartbeat";
const DEFAULT_CDP_TIMEOUT_MS = 10_000;
/** First reconnect delay; doubles per consecutive failure up to RECONNECT_MAX_DELAY_MS. */
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/**
 * A port that lived at least this long counts as a connection that worked, so the next drop
 * starts backing off from scratch. Anything shorter is the host failing on arrival.
 */
const STABLE_CONNECTION_MS = 10_000;
const CURSOR_ARRIVAL_TIMEOUT_MS = 1_000;
const MAX_USER_TABS = 1000;
const DEFAULT_SESSION_GROUP_TITLE = "Operon Task";
const DELIVERABLE_GROUP_TITLE = "✅ Operon";

class JsonRpcPeer {
  constructor(transport, handlers) {
    this.transport = transport;
    this.handlers = handlers;
    this.transport.setMessageCallback((message) => {
      void this.handleMessage(message);
    });
  }

  async handleMessage(message) {
    if (!message || typeof message !== "object" || typeof message.method !== "string") {
      return;
    }
    const id = message.id;
    try {
      const handler = this.handlers[message.method];
      if (typeof handler !== "function") {
        throw new Error(`No handler registered for method: ${message.method}`);
      }
      const result = await handler.call(this.handlers, message.params ?? {});
      if (id !== undefined) {
        this.transport.sendMessage({ jsonrpc: "2.0", id, result: result ?? {} });
      }
    } catch (error) {
      if (id !== undefined) {
        this.transport.sendMessage({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
  }

  sendNotification(method, params) {
    this.transport.sendMessage({ jsonrpc: "2.0", method, params });
  }
}

class NativeTransport {
  constructor(hostName) {
    this.hostName = hostName;
    this.port = null;
    this.messageCallback = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.connectedAt = 0;
    this.status = {
      hostName: this.hostName,
      lastChecked: Date.now(),
      reconnectAttempt: this.reconnectAttempt,
      state: "disconnected"
    };
    this.connect();
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === RECONNECT_ALARM_NAME && !this.port) {
        this.connect();
      }
    });
  }

  setMessageCallback(callback) {
    this.messageCallback = callback;
  }

  sendMessage(message) {
    if (!this.port) {
      // Only start a retry if none is pending. A caller showing up while we are down is not a
      // new failure, and counting it as one would push the next attempt further out — the exact
      // opposite of what that caller is waiting for.
      if (this.reconnectTimer == null) {
        this.scheduleReconnect("native host disconnected");
      }
      throw new Error("Native host is disconnected");
    }
    this.port.postMessage(message);
  }

  connect() {
    if (this.port) {
      return;
    }
    try {
      const port = chrome.runtime.connectNative(this.hostName);
      this.port = port;
      this.connectedAt = Date.now();
      this.clearReconnect();
      this.setStatus({ state: "connected" });
      port.onMessage.addListener((message) => {
        this.messageCallback?.(message);
      });
      port.onDisconnect.addListener(() => {
        this.port = null;
        // A port that worked and then dropped is a different failure from one that never came
        // up, and only the first deserves a fast retry. Every attempt makes Chrome exec the
        // wrapper again, so a host that dies on arrival — a half-written dev build, a missing
        // binary — must be allowed to back off instead of respawning Electron once a second.
        if (Date.now() - this.connectedAt >= STABLE_CONNECTION_MS) {
          this.reconnectAttempt = 0;
        }
        this.scheduleReconnect(chrome.runtime.lastError?.message ?? "native host disconnected");
      });
    } catch (error) {
      this.port = null;
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Bring the host back on our own. Two paths, because neither survives what the other does.
   *
   * Nobody else will do it for us: the client discovers backends by scanning a socket directory,
   * so it has no channel to this extension, and a `browsers.get("chrome")` that lands while we
   * are down just fails outright. Reconnect latency *is* that failure window — which is why the
   * first retry is a timer at ~1s and not an alarm at Chrome's 30s floor.
   *
   * The timer cannot be the only path: it dies with the service worker, and an evicted worker is
   * exactly the case where nothing is left to wake us. Alarms survive eviction, so one stays as
   * the backstop. Chrome clamps periodic alarms to 30s, so 0.5 is the honest floor — asking for
   * 0.1, as this did, silently gets 0.5 anyway.
   */
  scheduleReconnect(error) {
    this.reconnectAttempt += 1;
    const delayMs = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS
    );
    this.setStatus({
      state: "reconnecting",
      error,
      nextRetryMs: delayMs,
      reconnectAttempt: this.reconnectAttempt
    });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    chrome.alarms.create(RECONNECT_ALARM_NAME, { periodInMinutes: 0.5 }).catch(() => {});
  }

  /** Connected: stop retrying. The alarm is periodic and would otherwise outlive the reconnect. */
  clearReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    chrome.alarms.clear(RECONNECT_ALARM_NAME).catch(() => {});
  }

  setStatus(status) {
    this.status = {
      hostName: this.hostName,
      lastChecked: Date.now(),
      reconnectAttempt: this.reconnectAttempt,
      ...status
    };
    chrome.storage.local
      .set({
        [NATIVE_HOST_STATUS_KEY]: this.status
      })
      .catch(() => {});
  }

  getStatus() {
    return this.status;
  }
}

class SessionStore {
  constructor() {
    this.state = { sessions: {}, deliverableGroupId: null };
    this.ready = this.load();
  }

  async load() {
    const stored = await chrome.storage.local.get(SESSION_STATE_KEY);
    const value = stored[SESSION_STATE_KEY];
    if (value && typeof value === "object") {
      this.state = {
        sessions: value.sessions && typeof value.sessions === "object" ? value.sessions : {},
        deliverableGroupId:
          typeof value.deliverableGroupId === "number" ? value.deliverableGroupId : null
      };
      if (typeof this.state.deliverableGroupId === "number") {
        await chrome.tabGroups
          .update(this.state.deliverableGroupId, { title: DELIVERABLE_GROUP_TITLE })
          .catch(() => {});
      }
    }
  }

  async save() {
    await chrome.storage.local.set({ [SESSION_STATE_KEY]: this.state });
  }

  async getSession(sessionId) {
    await this.ready;
    const existing = this.state.sessions[sessionId];
    if (existing && typeof existing === "object") {
      // Sessions persisted by an older build predate tabMarks; markTab would otherwise
      // write through a hole in state that survives a service-worker restart.
      existing.tabMarks ??= {};
      return existing;
    }
    const created = {
      chromeGroupId: null,
      title: DEFAULT_SESSION_GROUP_TITLE,
      activeTabId: null,
      tabOrigins: {},
      // tabId -> {status, turnId}. See markTab.
      tabMarks: {}
    };
    this.state.sessions[sessionId] = created;
    await this.save();
    return created;
  }

  async removeSession(sessionId) {
    await this.ready;
    delete this.state.sessions[sessionId];
    await this.save();
  }

  async findSessionByGroup(groupId) {
    await this.ready;
    for (const [sessionId, session] of Object.entries(this.state.sessions)) {
      if (session.chromeGroupId === groupId) {
        return { sessionId, session };
      }
    }
    return null;
  }
}

class BrowserBackend {
  constructor() {
    this.store = new SessionStore();
    this.attachedTabs = new Set();
    /** tabId -> (targetId -> CDP sessionId), populated by attachTarget. */
    this.targetSessionsByTabId = new Map();
    this.activeTabsBySession = new Map();
    this.cursorByTabId = new Map();
    this.downloadFilenamesById = new Map();
    this.downloadUrlsById = new Map();
    this.downloadsById = new Map();
    this.downloadWaiters = new Set();
    this.downloadChangeListeners = new Set();
    this.cursorArrivalWaitersByKey = new Map();
    this.fileChoosersById = new Map();
    this.fileChooserWaitersByTabId = new Map();
    this.nextCursorMoveSequence = 1;
    chrome.debugger.onDetach.addListener((source) => {
      if (typeof source.tabId === "number") {
        this.attachedTabs.delete(source.tabId);
        // Chrome detached the debugger out from under us — user opened DevTools, another
        // debugger grabbed the tab, the tab crashed. Every CDP session under it is dead now,
        // so drop the remembered target sessions too; keeping them would let a later
        // attachTarget short-circuit and hand the client a session Chrome has forgotten.
        this.targetSessionsByTabId.delete(source.tabId);
      }
    });
  }

  ping() {
    return "pong";
  }

  /**
   * Backend handshake. The schema is the official client's zod object, not ours:
   *
   *   {apiSupportOverrides?: record(boolean), capabilities: {browser?, tab?},
   *    id: string, name: string, type: "iab"|"extension"|"cdp", metadata?: record(string)}
   *
   * Upstream returned `{name, version, type, metadata}` — no `id`, no `capabilities`,
   * plus a `version` the schema has no field for. Both omissions are required fields,
   * so the current official client rejects the handshake outright. This is the real
   * reason the upstream store build is unusable, ahead of any missing method.
   *
   * `params` carries the asking client's session params. Echoing its session_id back
   * makes one backend serve every session, matching how our IAB backend behaves.
   */
  async getInfo(params) {
    let { extensionInstanceId } = await chrome.storage.local.get("extensionInstanceId");
    if (typeof extensionInstanceId !== "string") {
      extensionInstanceId = crypto.randomUUID();
      await chrome.storage.local.set({ extensionInstanceId });
    }
    const askedSessionId = params?.session_id;
    return {
      id: extensionInstanceId,
      name: "Operon Chrome",
      type: "extension",
      // Chrome is inherently multi-tab, so we claim the four APIs the official client
      // only offers in multiTab mode. markDeliverable/markHandoff are extension-only —
      // api.json lists them unsupportedByDefaultIn ["iab","cdp"] — and they are exactly
      // what markTab() below serves.
      apiSupportOverrides: {
        "BrowserUser.claimTab": true,
        "Tab.markDeliverable": true,
        "Tab.markHandoff": true,
        "Tabs.finalize": true
      },
      // Deliberately empty. Our IAB backend advertises "visibility" and "viewport"
      // because it owns an Electron webview it can show, hide and resize. This backend
      // drives the user's own Chrome — there is no window we may hide on their behalf —
      // so we advertise nothing rather than offer the model a capability that would
      // then fail. `browser` and `tab` are optional inside `capabilities`; the key is not.
      capabilities: {},
      // Values must be strings: the official schema is record(string), not record(any).
      metadata: {
        extensionId: chrome.runtime.id,
        extensionInstanceId,
        extensionVersion: chrome.runtime.getManifest().version,
        nativeHostName: NATIVE_HOST_NAME,
        ...(typeof askedSessionId === "string" ? { operonSessionId: askedSessionId } : {})
      }
    };
  }

  async createTab(params) {
    const session = await this.requireSession(params);
    const chromeTab = await createBackgroundTab(params.preferredWindowId);
    await this.ensureSessionGroup(session.sessionId, chromeTab.id, "agent");
    await this.setSessionActiveTab(session.sessionId, chromeTab.id);
    return { ...toBrowserTab(chromeTab), active: true };
  }

  async closeTab(params) {
    const session = await this.requireSession(params);
    await this.requireSessionTab(params, "closeTab");
    const tabId = requireTabId(params, "closeTab");
    const sessionState = await this.store.getSession(session.sessionId);
    if (this.attachedTabs.has(tabId)) {
      await this.detachTab(tabId);
    }
    if (sessionState.tabOrigins[String(tabId)] === "agent") {
      await chrome.tabs.remove(tabId);
    } else if (chrome.tabs.ungroup) {
      await chrome.tabs.ungroup(tabId);
    }
    delete sessionState.tabOrigins[String(tabId)];
    delete sessionState.tabMarks[String(tabId)];
    if (sessionState.activeTabId === tabId) {
      delete sessionState.activeTabId;
    }
    await this.store.save();
  }

  async getTabs(params) {
    const session = await this.requireSession(params);
    const tabs = await this.getSessionTabs(session.sessionId);
    return await this.withLogicalActive(session.sessionId, tabs.map(toBrowserTab));
  }

  async getUserTabs(params) {
    await this.requireSession(params);
    const tabs = (await chrome.tabs.query({}))
      .filter(hasTabId)
      .sort(compareLastAccessed)
      .slice(0, MAX_USER_TABS);
    const groupTitles = await readGroupTitles(tabs);
    return tabs.map((tab) => toUserTab(tab, groupTitles));
  }

  async getUserHistory(params) {
    await this.requireSession(params);
    const query = typeof params.query === "string" ? params.query : "";
    const maxResults =
      Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 100;
    const search = { text: query, maxResults };
    if (typeof params.from === "string") {
      search.startTime = parseDate(params.from, "from");
    }
    if (typeof params.to === "string") {
      search.endTime = parseDate(params.to, "to");
    }
    const results = await chrome.history.search(search);
    return results.flatMap((item) => {
      if (typeof item.url !== "string" || typeof item.lastVisitTime !== "number") {
        return [];
      }
      return [
        {
          url: item.url,
          ...(item.title ? { title: item.title } : {}),
          dateVisited: new Date(item.lastVisitTime).toISOString()
        }
      ];
    });
  }

  async claimUserTab(params) {
    const session = await this.requireSession(params);
    const tabId = requireTabId(params, "claimUserTab");
    const tab = await chrome.tabs.get(tabId);
    if (!hasTabId(tab)) {
      throw new Error(`Chrome tab ${tabId} has no id`);
    }
    if (tab.url?.startsWith("chrome://")) {
      throw new Error(`Chrome internal tab ${tabId} cannot be claimed`);
    }
    if (typeof tab.groupId === "number" && tab.groupId !== -1) {
      const owner = await this.store.findSessionByGroup(tab.groupId);
      if (owner && owner.sessionId !== session.sessionId) {
        throw new Error(`Tab ${tabId} is already part of browser session ${owner.sessionId}`);
      }
    }
    await this.ensureSessionGroup(session.sessionId, tab.id, "user");
    await this.setSessionActiveTab(session.sessionId, tab.id);
    return { ...toBrowserTab(tab), active: true };
  }

  /**
   * Explicit end-of-turn disposition: `keep` is complete and authoritative.
   *
   * Any session tab left out of `keep` is closed or released even if markTab marked it
   * earlier in the turn. That is the documented contract — "omit tabs by default", and
   * omission is a positive instruction, not an absence of one. The two paths belong to
   * different surfaces and are not meant to be combined; when they are, the one that
   * speaks for the end of the turn wins.
   */
  async finalizeTabs(params) {
    const session = await this.requireSession(params);
    if (!Array.isArray(params.keep)) {
      throw new Error("finalizeTabs requires keep array");
    }
    const tabs = await this.getSessionTabs(session.sessionId);
    const knownTabIds = new Set(tabs.filter(hasTabId).map((tab) => tab.id));
    const keep = new Map();
    for (const entry of params.keep) {
      if (!entry || typeof entry !== "object") {
        throw new Error("finalizeTabs received invalid tab entry");
      }
      const tabId = requireTabId(entry, "finalizeTabs");
      if (!knownTabIds.has(tabId)) {
        throw new Error(`finalizeTabs cannot keep unknown tab ${tabId}`);
      }
      if (keep.has(tabId)) {
        throw new Error(`finalizeTabs received duplicate tab ${tabId}`);
      }
      const status = entry.status;
      if (status !== "handoff" && status !== "deliverable") {
        throw new Error(`finalizeTabs received invalid status ${String(status)}`);
      }
      keep.set(tabId, status);
    }
    // "Treat finalize as the final browser action of the turn" — so record that it ran, and
    // turnEnded will not second-guess it. Without this, finalizing with a handoff tab keeps
    // the session alive, and the turnEnded that follows would close the tab we just kept.
    const sessionState = await this.store.getSession(session.sessionId);
    sessionState.finalizedTurnId = session.turnId;
    await this.applyTabDispositions(session.sessionId, tabs, (tabId) => keep.get(tabId));
  }

  /**
   * Sort the session's tabs by disposition and act on each group.
   *
   * Shared by finalizeTabs and turnEnded so Chrome's grouping rules live in one place;
   * the two differ only in where a tab's status comes from. `statusOf` returns
   * "handoff", "deliverable", or undefined for "the model did not ask to keep this".
   */
  async applyTabDispositions(sessionId, tabs, statusOf) {
    const sessionState = await this.store.getSession(sessionId);
    const agentTabsToClose = [];
    const userTabsToRelease = [];
    const deliverableTabs = [];
    const handoffTabs = [];
    for (const tab of tabs) {
      if (!hasTabId(tab)) {
        continue;
      }
      const keptStatus = statusOf(tab.id);
      if (keptStatus === "handoff") {
        handoffTabs.push(tab.id);
        continue;
      }
      if (keptStatus === "deliverable") {
        deliverableTabs.push(tab.id);
        continue;
      }
      if (sessionState.tabOrigins[String(tab.id)] === "agent") {
        agentTabsToClose.push(tab.id);
      } else {
        userTabsToRelease.push(tab.id);
      }
    }
    // Detach every disposition, including handoff tabs we keep alive: leaving a
    // tab attached keeps Chrome's "started debugging this browser" banner up
    // after the turn ends. The debugger re-attaches lazily on the next CDP call
    // (the CLI runner and background handlers attach on demand), so dropping it
    // here is loss-free while clearing the banner.
    await this.detachMany([
      ...agentTabsToClose,
      ...userTabsToRelease,
      ...deliverableTabs,
      ...handoffTabs
    ]);
    if (agentTabsToClose.length > 0) {
      await chrome.tabs.remove(agentTabsToClose.length === 1 ? agentTabsToClose[0] : agentTabsToClose);
    }
    if (userTabsToRelease.length > 0 && chrome.tabs.ungroup) {
      await chrome.tabs.ungroup(userTabsToRelease.length === 1 ? userTabsToRelease[0] : userTabsToRelease);
    }
    if (deliverableTabs.length > 0) {
      await this.moveToDeliverables(deliverableTabs);
    }
    for (const tabId of [...agentTabsToClose, ...userTabsToRelease, ...deliverableTabs]) {
      delete sessionState.tabOrigins[String(tabId)];
      delete sessionState.tabMarks[String(tabId)];
      this.cursorByTabId.delete(tabId);
    }
    if (handoffTabs.length > 0) {
      // Marks are turn-scoped: a handoff tab that survives into the next turn must be
      // marked again to survive that one too, so its mark does not carry over.
      for (const tabId of handoffTabs) {
        delete sessionState.tabMarks[String(tabId)];
      }
      sessionState.activeTabId = handoffTabs.includes(sessionState.activeTabId)
        ? sessionState.activeTabId
        : handoffTabs[0];
      this.activeTabsBySession.set(sessionId, sessionState.activeTabId);
      await this.store.save();
    } else {
      this.activeTabsBySession.delete(sessionId);
      await this.store.removeSession(sessionId);
    }
  }

  async nameSession(params) {
    const session = await this.requireSession(params);
    const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : DEFAULT_SESSION_GROUP_TITLE;
    const sessionState = await this.store.getSession(session.sessionId);
    sessionState.title = name;
    await this.store.save();
    if (typeof sessionState.chromeGroupId === "number") {
      await chrome.tabGroups.update(sessionState.chromeGroupId, { title: name }).catch(() => {});
    }
  }

  async attach(params) {
    await this.requireSessionTab(params, "attach");
    const tabId = requireTabId(params, "attach");
    if (!this.attachedTabs.has(tabId)) {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch (error) {
        if (!String(error?.message ?? error).includes("Another debugger")) {
          throw error;
        }
      }
      this.attachedTabs.add(tabId);
    }
  }

  /**
   * Attach to one target (an OOPIF, typically) inside an already-attached tab.
   *
   * chrome.debugger attaches per tab; the client needs per-target CDP sessions to
   * reach cross-origin frames. Target.attachToTarget with flatten:true makes Chrome
   * emit Target.attachedToTarget, which reaches the client through the onCDPEvent
   * notification we already forward — that is how it learns the sessionId to address
   * the frame with. If the event is missed the client falls back to {tabId, targetId},
   * which chrome.debugger.sendCommand also accepts, so both paths work.
   */
  async attachTarget(params) {
    await this.requireSessionTab(params, "attachTarget");
    const tabId = requireTabId(params, "attachTarget");
    const targetId = requireTargetId(params, "attachTarget");
    await this.attach(params);
    if (this.targetSessionsByTabId.get(tabId)?.has(targetId)) {
      return;
    }
    const result = await chrome.debugger.sendCommand({ tabId }, "Target.attachToTarget", {
      targetId,
      flatten: true
    });
    if (typeof result?.sessionId !== "string") {
      throw new Error("Target.attachToTarget did not return a sessionId");
    }
    let sessions = this.targetSessionsByTabId.get(tabId);
    if (!sessions) {
      sessions = new Map();
      this.targetSessionsByTabId.set(tabId, sessions);
    }
    sessions.set(targetId, result.sessionId);
  }

  async detach(params) {
    await this.requireSessionTab(params, "detach");
    const tabId = requireTabId(params, "detach");
    await this.detachTab(tabId);
  }

  /**
   * Detach one target without dropping the tab's debugger session.
   *
   * Unknown targets resolve silently: the client detaches frame targets in bulk on
   * teardown (`Promise.allSettled` over every remembered target id) and a tab-level
   * detach already dropped them all, so throwing here would only manufacture noise.
   */
  async detachTarget(params) {
    await this.requireSessionTab(params, "detachTarget");
    const tabId = requireTabId(params, "detachTarget");
    const targetId = requireTargetId(params, "detachTarget");
    const sessionId = this.targetSessionsByTabId.get(tabId)?.get(targetId);
    if (sessionId === undefined) {
      return;
    }
    try {
      await chrome.debugger.sendCommand({ tabId }, "Target.detachFromTarget", { sessionId });
    } finally {
      this.forgetTargetSession(tabId, targetId);
    }
  }

  /**
   * Mark one tab's disposition ahead of the turn ending, so finalizeTabs is not the
   * only place a tab can be saved. Backs Tab.markHandoff / Tab.markDeliverable, which
   * api.json lists as extension-only (unsupportedByDefaultIn ["iab","cdp"]).
   *
   * Marking only records intent — nothing moves until the turn ends. finalizeTabs
   * remains authoritative: what it is told to keep wins over what was marked here,
   * because it speaks for the end of the turn and this speaks for the middle of it.
   */
  async markTab(params) {
    const session = await this.requireSession(params);
    await this.requireSessionTab(params, "markTab");
    const tabId = requireTabId(params, "markTab");
    const status = params.status;
    if (status !== "handoff" && status !== "deliverable") {
      throw new Error(`markTab received invalid status ${String(status)}`);
    }
    const sessionState = await this.store.getSession(session.sessionId);
    // Latest mark for a tab wins, and the turn is recorded so turnEnded can tell a mark
    // made during this turn from one left over by an earlier one.
    sessionState.tabMarks[String(tabId)] = { status, turnId: session.turnId };
    await this.store.save();
  }

  async executeCdp(params) {
    await this.requireSession(params);
    const target = params.target && typeof params.target === "object" ? params.target : {};
    const tabId = target.tabId;
    if (typeof tabId === "number") {
      await this.requireSessionTab({ ...params, tabId }, "executeCdp");
      if (!this.attachedTabs.has(tabId)) {
        throw new Error("Debugger unattached");
      }
    }
    // A target-scoped command must be addressed by the CDP session attachTarget opened,
    // not by targetId: chrome.debugger routes on sessionId. The client sends {tabId,
    // targetId} whenever it did not see the Target.attachedToTarget event go by, so
    // translating here is what makes that fallback path work at all.
    const resolved = { ...target };
    if (typeof tabId === "number" && typeof target.targetId === "string" && target.sessionId == null) {
      const sessionId = this.targetSessionsByTabId.get(tabId)?.get(target.targetId);
      if (sessionId === undefined) {
        throw new Error(`No debugger session is attached for target ${target.targetId}`);
      }
      delete resolved.targetId;
      resolved.sessionId = sessionId;
    }
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    return await withTimeout(timeoutMs, async () => {
      if (params.method === "Target.getTargets") {
        return { targetInfos: await chrome.debugger.getTargets() };
      }
      if (typeof params.method !== "string") {
        throw new Error("executeCdp requires method");
      }
      return await chrome.debugger.sendCommand(resolved, params.method, params.commandParams ?? {});
    });
  }

  async moveMouse(params) {
    const session = await this.requireSession(params);
    await this.requireSessionTab(params, "moveMouse");
    const tabId = requireTabId(params, "moveMouse");
    if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
      throw new Error("moveMouse requires finite x and y");
    }
    const cursorReady = await this.ensureCursorContentScript(session.sessionId, tabId);
    if (!cursorReady) {
      throw new Error(`Cannot inject cursor content script into tab ${tabId}`);
    }
    const moveSequence = this.nextCursorMoveSequence;
    this.nextCursorMoveSequence += 1;
    const cursor = {
      moveSequence,
      visible: true,
      x: params.x,
      y: params.y
    };
    this.cursorByTabId.set(tabId, cursor);
    const arrivalWaiter =
      params.waitForArrival === false
        ? null
        : this.createCursorArrivalWaiter(params.session_id, params.turn_id, moveSequence);
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "OPERON_BROWSER_USE_CURSOR",
        sessionId: params.session_id,
        turnId: params.turn_id,
        moveSequence,
        x: cursor.x,
        y: cursor.y,
        visible: cursor.visible
      });
      await arrivalWaiter?.promise;
    } catch (error) {
      arrivalWaiter?.cancel();
      throw error;
    }
  }

  async waitForFileChooser(params) {
    await this.requireSessionTab(params, "waitForFileChooser");
    const tabId = requireTabId(params, "waitForFileChooser");
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    const waitForEvent = this.waitForFileChooserEvent(tabId);
    try {
      await chrome.debugger.sendCommand({ tabId }, "Page.setInterceptFileChooserDialog", {
        enabled: true
      });
      return await withTimeout(timeoutMs, () => waitForEvent);
    } finally {
      this.fileChooserWaitersByTabId.delete(tabId);
      await chrome.debugger
        .sendCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => {});
    }
  }

  async setFileChooserFiles(params) {
    await this.requireSession(params);
    if (typeof params.fileChooserId !== "string" || params.fileChooserId === "") {
      throw new Error("setFileChooserFiles requires fileChooserId");
    }
    const chooser = this.fileChoosersById.get(params.fileChooserId);
    if (!chooser) {
      throw new Error(`Unknown file chooser id "${params.fileChooserId}"`);
    }
    await this.requireSessionTab({ ...params, tabId: chooser.tabId }, "setFileChooserFiles");
    if (!Array.isArray(params.files) || params.files.length === 0) {
      throw new Error("setFileChooserFiles requires at least one file");
    }
    const files = params.files.map((file) => {
      if (typeof file !== "string" || file === "") {
        throw new Error("setFileChooserFiles files must be non-empty strings");
      }
      return file;
    });
    if (!chooser.isMultiple && files.length > 1) {
      throw new Error("File chooser does not accept multiple files");
    }
    await chrome.debugger.sendCommand({ tabId: chooser.tabId }, "DOM.setFileInputFiles", {
      backendNodeId: chooser.backendNodeId,
      files
    });
    this.fileChoosersById.delete(params.fileChooserId);
  }

  async waitForDownload(params) {
    await this.requireSessionTab(params, "waitForDownload");
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    const download = await this.waitForDownloadChange(
      (change) =>
        change.status === "started" ||
        change.status === "in_progress" ||
        change.status === "complete",
      timeoutMs,
      "Timed out waiting for download."
    );
    return { downloadId: download.id };
  }

  async downloadPath(params) {
    await this.requireSession(params);
    if (typeof params.downloadId !== "string" || params.downloadId === "") {
      throw new Error("downloadPath requires downloadId");
    }
    const current = this.downloadsById.get(params.downloadId);
    if (current?.status === "complete") {
      return { path: current.filename ?? null };
    }
    if (current?.status === "failed" || current?.status === "canceled") {
      return { path: null };
    }
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    const download = await this.waitForDownloadChange(
      (change) =>
        change.id === params.downloadId &&
        (change.status === "complete" || change.status === "failed" || change.status === "canceled"),
      timeoutMs,
      `Timed out waiting for download ${params.downloadId}.`
    );
    return { path: download.status === "complete" ? download.filename ?? null : null };
  }

  async readClipboardText(params) {
    await this.requireSessionTab(params, "readClipboardText");
    const tabId = requireTabId(params, "readClipboardText");
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    const text = await this.evaluateJavascript(tabId, "navigator.clipboard.readText()", true);
    return { text: typeof text === "string" ? text : "" };
  }

  async writeClipboardText(params) {
    await this.requireSessionTab(params, "writeClipboardText");
    const tabId = requireTabId(params, "writeClipboardText");
    if (typeof params.text !== "string") {
      throw new Error("writeClipboardText requires text");
    }
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    await this.evaluateJavascript(tabId, `navigator.clipboard.writeText(${JSON.stringify(params.text)})`, true);
  }

  async readClipboard(params) {
    await this.requireSessionTab(params, "readClipboard");
    const tabId = requireTabId(params, "readClipboard");
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    const items = await this.evaluateJavascript(
      tabId,
      `((async () => {
        const clipboardItems = await navigator.clipboard.read();
        return await Promise.all(clipboardItems.map(async (item) => {
          const entries = await Promise.all(item.types.map(async (type) => {
            const blob = await item.getType(type);
            if (type.startsWith("text/")) {
              return { mime_type: type, text: await blob.text() };
            }
            const base64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(reader.error);
              reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
              reader.readAsDataURL(blob);
            });
            return { mime_type: type, base64 };
          }));
          return { entries, presentation_style: item.presentationStyle ?? "unspecified" };
        }));
      })())`,
      true
    );
    return { items: Array.isArray(items) ? items : [] };
  }

  async writeClipboard(params) {
    await this.requireSessionTab(params, "writeClipboard");
    const tabId = requireTabId(params, "writeClipboard");
    if (!Array.isArray(params.items)) {
      throw new Error("writeClipboard requires items");
    }
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    await this.evaluateJavascript(
      tabId,
      `((async (items) => {
        const clipboardItems = items.map((item) => {
          const entries = {};
          for (const entry of item.entries ?? []) {
            const mime = entry.mime_type;
            if (!mime) continue;
            if (entry.text !== undefined) {
              entries[mime] = new Blob([entry.text], { type: mime });
            } else if (entry.base64 !== undefined) {
              const binary = atob(entry.base64);
              const bytes = new Uint8Array(binary.length);
              for (let index = 0; index < binary.length; index += 1) {
                bytes[index] = binary.charCodeAt(index);
              }
              entries[mime] = new Blob([bytes], { type: mime });
            }
          }
          return new ClipboardItem(entries, { presentationStyle: item.presentation_style ?? "unspecified" });
        });
        await navigator.clipboard.write(clipboardItems);
      })(${JSON.stringify(params.items)}))`,
      true
    );
  }

  /**
   * Implicit end-of-turn disposition, driven by markTab instead of an explicit keep list.
   *
   * Upstream only detached here, because it implements the finalize flow alone: the model
   * is told to always call finalizeTabs, so nothing else needs to clean up. But the mark
   * flow's contract is "agent-created tabs are ephemeral and close automatically when the
   * turn ends unless you mark them", and under that contract a detach-only turnEnded
   * leaks every tab the agent opened. So we apply the marks here.
   *
   * Defers to finalizeTabs when the model used that flow instead: finalize is defined as
   * the final browser action of the turn, and it has already detached and disposed. Note it
   * is not enough to check whether the session still exists — finalize keeps the session
   * alive when it retains a handoff tab, and that tab is precisely the one we must not close.
   *
   * Only marks from *this* turn count. A stale mark left by an earlier turn must not keep
   * a tab alive forever — that is what makes marks turn-scoped rather than sticky.
   */
  async turnEnded(params) {
    const session = await this.requireSession(params);
    const tabs = await this.getSessionTabs(session.sessionId);
    if (tabs.length === 0) {
      this.activeTabsBySession.delete(session.sessionId);
      return;
    }
    const sessionState = await this.store.getSession(session.sessionId);
    if (sessionState.finalizedTurnId === session.turnId) {
      this.activeTabsBySession.delete(session.sessionId);
      return;
    }
    const liveTabIds = tabs.filter(hasTabId).map((tab) => tab.id);
    await this.applyTabDispositions(session.sessionId, tabs, (tabId) => {
      const mark = sessionState.tabMarks[String(tabId)];
      return mark?.turnId === session.turnId ? mark.status : undefined;
    });
    await Promise.allSettled(liveTabIds.map((tabId) => this.publishCursorState(tabId)));
  }

  async executeUnhandledCommand(params) {
    throw new Error(`Operon Chrome does not support command "${params.type}"`);
  }

  addDownloadChangeListener(listener) {
    this.downloadChangeListeners.add(listener);
    return () => this.downloadChangeListeners.delete(listener);
  }

  handleDownloadCreated(item) {
    if (!this.isBrowserControlActive() || !Number.isInteger(item?.id)) {
      return;
    }
    const filename = typeof item.filename === "string" ? item.filename : "";
    const url =
      typeof item.finalUrl === "string" ? item.finalUrl : typeof item.url === "string" ? item.url : "";
    this.downloadFilenamesById.set(item.id, filename);
    this.downloadUrlsById.set(item.id, url);
    this.emitDownloadChange({
      id: String(item.id),
      filename,
      url,
      status: "started"
    });
  }

  handleDownloadChanged(delta) {
    if (!Number.isInteger(delta?.id)) {
      return;
    }
    const filename =
      typeof delta.filename?.current === "string"
        ? delta.filename.current
        : this.downloadFilenamesById.get(delta.id);
    const url = this.downloadUrlsById.get(delta.id);
    if (typeof filename !== "string" || typeof url !== "string") {
      return;
    }
    this.downloadFilenamesById.set(delta.id, filename);
    const status = downloadStatus(delta);
    if (!status) {
      return;
    }
    this.emitDownloadChange({
      id: String(delta.id),
      filename,
      url,
      status
    });
    if (status === "complete" || status === "failed" || status === "canceled") {
      this.downloadFilenamesById.delete(delta.id);
      this.downloadUrlsById.delete(delta.id);
    }
  }

  notifyCursorArrived(params) {
    const moveSequence = params?.moveSequence;
    if (!Number.isInteger(moveSequence)) {
      return false;
    }
    const waiter = this.cursorArrivalWaitersByKey.get(cursorArrivalKey(params.sessionId, params.turnId, moveSequence));
    waiter?.();
    return Boolean(waiter);
  }

  handleCdpEvent(source, method, params) {
    if (method !== "Page.fileChooserOpened" || typeof source?.tabId !== "number") {
      return;
    }
    const waiter = this.fileChooserWaitersByTabId.get(source.tabId);
    waiter?.resolve(params ?? {});
  }

  waitForFileChooserEvent(tabId) {
    if (this.fileChooserWaitersByTabId.has(tabId)) {
      throw new Error(`Already waiting for file chooser in tab ${tabId}`);
    }
    return new Promise((resolve, reject) => {
      this.fileChooserWaitersByTabId.set(tabId, {
        resolve: (event) => {
          this.fileChooserWaitersByTabId.delete(tabId);
          if (!Number.isInteger(event.backendNodeId)) {
            reject(new Error("File chooser event did not include backendNodeId"));
            return;
          }
          const fileChooserId = crypto.randomUUID();
          const chooser = {
            tabId,
            backendNodeId: event.backendNodeId,
            isMultiple: event.mode === "selectMultiple"
          };
          this.fileChoosersById.set(fileChooserId, chooser);
          resolve({
            fileChooserId,
            isMultiple: chooser.isMultiple
          });
        }
      });
    });
  }

  readCursorOverlayState(tabId) {
    for (const [sessionId, activeTabId] of this.activeTabsBySession) {
      if (activeTabId === tabId) {
        return {
          cursor: this.cursorByTabId.get(tabId) ?? null,
          isVisible: true,
          sessionId,
          turnId: null
        };
      }
    }
    return {
      cursor: null,
      isVisible: false,
      sessionId: null,
      turnId: null
    };
  }

  isBrowserControlActive() {
    return this.activeTabsBySession.size > 0;
  }

  createCursorArrivalWaiter(sessionId, turnId, moveSequence) {
    const key = cursorArrivalKey(sessionId, turnId, moveSequence);
    let timeoutId;
    let resolvePromise;
    const resolve = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      this.cursorArrivalWaitersByKey.delete(key);
      resolvePromise?.();
    };
    const promise = new Promise((resolveInner) => {
      resolvePromise = resolveInner;
      timeoutId = setTimeout(resolve, CURSOR_ARRIVAL_TIMEOUT_MS);
      this.cursorArrivalWaitersByKey.set(key, resolve);
    });
    return { promise, cancel: resolve };
  }

  emitDownloadChange(change) {
    this.downloadsById.set(change.id, {
      ...(this.downloadsById.get(change.id) ?? {}),
      ...change
    });
    for (const waiter of [...this.downloadWaiters]) {
      if (waiter.predicate(change)) {
        waiter.resolve(change);
      }
    }
    for (const listener of this.downloadChangeListeners) {
      listener(change);
    }
  }

  waitForDownloadChange(predicate, timeoutMs, timeoutMessage) {
    for (const change of this.downloadsById.values()) {
      if (predicate(change)) {
        return Promise.resolve(change);
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (change) => {
          cleanup();
          resolve(change);
        }
      };
      const cleanup = () => {
        clearTimeout(timeoutId);
        this.downloadWaiters.delete(waiter);
      };
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.downloadWaiters.add(waiter);
    });
  }

  async evaluateJavascript(tabId, expression, awaitPromise) {
    const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "JavaScript evaluation failed");
    }
    return result.result?.value;
  }

  async ensureSessionGroup(sessionId, tabId, origin) {
    const session = await this.store.getSession(sessionId);
    let groupId = session.chromeGroupId;
    if (typeof groupId === "number") {
      try {
        await chrome.tabGroups.get(groupId);
        await chrome.tabs.group({ groupId, tabIds: [tabId] });
      } catch {
        groupId = null;
      }
    }
    if (typeof groupId !== "number") {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
      session.chromeGroupId = groupId;
    }
    session.tabOrigins[String(tabId)] = origin;
    await this.store.save();
    await chrome.tabGroups.update(groupId, {
      title: session.title,
      color: "blue",
      collapsed: false
    });
  }

  async setSessionActiveTab(sessionId, tabId) {
    const session = await this.store.getSession(sessionId);
    session.activeTabId = tabId;
    this.activeTabsBySession.set(sessionId, tabId);
    await this.store.save();
    await this.publishCursorState(tabId);
  }

  async getSessionTabs(sessionId) {
    const session = await this.store.getSession(sessionId);
    if (typeof session.chromeGroupId !== "number") {
      return [];
    }
    try {
      return (await chrome.tabs.query({ groupId: session.chromeGroupId })).filter(
        (tab) => hasTabId(tab) && !tab.url?.startsWith("chrome://")
      );
    } catch {
      await this.store.removeSession(sessionId);
      return [];
    }
  }

  async requireSession(params) {
    if (!params || typeof params !== "object") {
      throw new Error("Missing browser session params");
    }
    if (typeof params.session_id !== "string") {
      throw new Error("Missing required browser session_id");
    }
    if (typeof params.turn_id !== "string") {
      throw new Error("Missing required browser turn_id");
    }
    await this.store.getSession(params.session_id);
    return { sessionId: params.session_id, turnId: params.turn_id };
  }

  async requireSessionTab(params, command) {
    const session = await this.requireSession(params);
    const tabId = requireTabId(params, command);
    const tabs = await this.getSessionTabs(session.sessionId);
    if (!tabs.some((tab) => tab.id === tabId)) {
      throw new Error(`Tab ${tabId} is not part of browser session ${session.sessionId}`);
    }
  }

  async withLogicalActive(sessionId, tabs) {
    if (tabs.length === 0) {
      return tabs;
    }
    const session = await this.store.getSession(sessionId);
    let activeTabId = this.activeTabsBySession.get(sessionId) ?? session.activeTabId;
    if (!tabs.some((tab) => tab.id === activeTabId)) {
      activeTabId = tabs.find((tab) => tab.active)?.id ?? tabs[0].id;
      await this.setSessionActiveTab(sessionId, activeTabId);
    } else if (!this.activeTabsBySession.has(sessionId)) {
      this.activeTabsBySession.set(sessionId, activeTabId);
    }
    return tabs.map((tab) => ({ ...tab, active: tab.id === activeTabId }));
  }

  async moveToDeliverables(tabIds) {
    if (!Array.isArray(tabIds) || tabIds.length === 0) {
      return;
    }

    const tabRecords = await Promise.all(
      tabIds.map((id) => chrome.tabs.get(id).catch(() => null))
    );
    const tabsByWindow = new Map();
    for (const tab of tabRecords) {
      if (!tab || typeof tab.id !== "number" || typeof tab.windowId !== "number") continue;
      const arr = tabsByWindow.get(tab.windowId) ?? [];
      arr.push(tab.id);
      tabsByWindow.set(tab.windowId, arr);
    }
    if (tabsByWindow.size === 0) {
      return;
    }

    const storedGroupId = this.store.state.deliverableGroupId;
    let lastGroupId = null;

    for (const [windowId, windowTabIds] of tabsByWindow) {
      const existingGroups = await chrome.tabGroups
        .query({ windowId, title: DELIVERABLE_GROUP_TITLE })
        .catch(() => []);

      let primaryGroupId = null;
      if (existingGroups.length > 0) {
        const preferred =
          existingGroups.find((g) => g.id === storedGroupId) ??
          existingGroups.reduce((min, g) => (g.id < min.id ? g : min), existingGroups[0]);
        primaryGroupId = preferred.id;

        for (const group of existingGroups) {
          if (group.id === primaryGroupId) continue;
          const dupTabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
          const dupTabIds = dupTabs
            .map((t) => t.id)
            .filter((id) => typeof id === "number");
          if (dupTabIds.length > 0) {
            await chrome.tabs
              .group({ groupId: primaryGroupId, tabIds: dupTabIds })
              .catch(() => {});
          }
        }
      }

      if (typeof primaryGroupId === "number") {
        try {
          await chrome.tabs.group({ groupId: primaryGroupId, tabIds: windowTabIds });
        } catch {
          primaryGroupId = null;
        }
      }

      if (typeof primaryGroupId !== "number") {
        primaryGroupId = await chrome.tabs.group({ tabIds: windowTabIds });
      }

      await chrome.tabGroups
        .update(primaryGroupId, {
          title: DELIVERABLE_GROUP_TITLE,
          color: "green",
          collapsed: false
        })
        .catch(() => {});

      lastGroupId = primaryGroupId;
    }

    if (typeof lastGroupId === "number") {
      this.store.state.deliverableGroupId = lastGroupId;
      await this.store.save();
    }
  }

  async detachMany(tabIds) {
    await Promise.allSettled(tabIds.map((tabId) => this.detachTab(tabId)));
  }

  forgetTargetSession(tabId, targetId) {
    const sessions = this.targetSessionsByTabId.get(tabId);
    if (!sessions) {
      return;
    }
    sessions.delete(targetId);
    if (sessions.size === 0) {
      this.targetSessionsByTabId.delete(tabId);
    }
  }

  async detachTab(tabId) {
    try {
      await chrome.debugger.detach({ tabId });
    } finally {
      this.attachedTabs.delete(tabId);
      // Detaching the tab drops every CDP session under it, so the remembered target
      // sessions are dead ids now. Keeping them would make a later attachTarget for the
      // same targetId return early and hand the client a session Chrome has forgotten.
      this.targetSessionsByTabId.delete(tabId);
      for (const [fileChooserId, chooser] of this.fileChoosersById) {
        if (chooser.tabId === tabId) {
          this.fileChoosersById.delete(fileChooserId);
        }
      }
      this.cursorByTabId.delete(tabId);
    }
  }

  async ensureCursorContentScript(sessionId, tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "OPERON_BROWSER_USE_PING" });
      if (response?.ok) {
        return true;
      }
    } catch {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-cursor.js"]
      });
      return true;
    } catch {
      return false;
    }
  }

  async publishCursorState(tabId) {
    if (!(await this.ensureCursorContentScript(null, tabId))) {
      return false;
    }
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "OPERON_BROWSER_USE_CURSOR_STATE",
        state: this.readCursorOverlayState(tabId)
      });
      return response?.ok === true;
    } catch {
      return false;
    }
  }
}

function hasTabId(tab) {
  return typeof tab?.id === "number";
}

function toBrowserTab(tab) {
  return {
    id: tab.id,
    title: tab.title,
    active: tab.active,
    url: tab.url
  };
}

function toUserTab(tab, groupTitles) {
  const lastAccessed =
    typeof tab.lastAccessed === "number" && Number.isFinite(tab.lastAccessed)
      ? new Date(tab.lastAccessed).toISOString()
      : undefined;
  const groupTitle =
    typeof tab.groupId === "number" && tab.groupId !== -1 ? groupTitles.get(tab.groupId) : undefined;
  return {
    id: tab.id,
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.url ? { url: tab.url } : {}),
    ...(lastAccessed ? { lastOpened: lastAccessed } : {}),
    ...(groupTitle ? { tabGroup: groupTitle } : {})
  };
}

function requireTabId(params, command) {
  if (!Number.isInteger(params.tabId)) {
    throw new Error(`${command} requires an integer tabId`);
  }
  return params.tabId;
}

function requireTargetId(params, command) {
  if (typeof params.targetId !== "string" || params.targetId === "") {
    throw new Error(`${command} requires a non-empty targetId`);
  }
  return params.targetId;
}

async function createBackgroundTab(preferredWindowId) {
  const windowId = await chooseWindowId(preferredWindowId);
  if (typeof windowId === "number") {
    const tab = await chrome.tabs.create({ active: false, url: "about:blank", windowId });
    if (hasTabId(tab)) {
      return tab;
    }
  }
  const win = await chrome.windows.create({
    focused: false,
    type: "normal",
    url: "about:blank"
  });
  const tab = win.tabs?.find(hasTabId);
  if (!tab) {
    throw new Error("Created Chrome window has no tab");
  }
  return tab;
}

/**
 * `preferredWindowId` is the client's request to put the new tab beside a tab it already
 * has, so one session's tabs stay in one window. It is a preference, not a requirement:
 * a window id from a previous run may be gone, in which case we fall back rather than fail.
 */
async function chooseWindowId(preferredWindowId) {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  if (Number.isInteger(preferredWindowId) && windows.some((win) => win.id === preferredWindowId)) {
    return preferredWindowId;
  }
  const focused = windows.find((win) => win.focused && typeof win.id === "number");
  return focused?.id ?? windows.find((win) => typeof win.id === "number")?.id ?? null;
}

async function readGroupTitles(tabs) {
  const ids = new Set(
    tabs
      .map((tab) => tab.groupId)
      .filter((groupId) => typeof groupId === "number" && groupId !== -1)
  );
  const entries = await Promise.all(
    [...ids].map(async (groupId) => {
      try {
        const group = await chrome.tabGroups.get(groupId);
        return group.title ? [groupId, group.title] : null;
      } catch {
        return null;
      }
    })
  );
  return new Map(entries.filter(Boolean));
}

function compareLastAccessed(left, right) {
  const byLastAccessed = (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0);
  if (byLastAccessed !== 0) {
    return byLastAccessed;
  }
  const byWindow = (left.windowId ?? 0) - (right.windowId ?? 0);
  return byWindow !== 0 ? byWindow : (left.index ?? 0) - (right.index ?? 0);
}

function parseDate(value, field) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`getUserHistory requires ${field} to be a valid date`);
  }
  return timestamp;
}

function downloadStatus(delta) {
  switch (delta.state?.current) {
    case "complete":
      return "complete";
    case "interrupted":
      return delta.error?.current === "USER_CANCELED" ? "canceled" : "failed";
    case "in_progress":
      return "in_progress";
    default:
      return undefined;
  }
}

function cursorArrivalKey(sessionId, turnId, moveSequence) {
  return `${sessionId}:${turnId}:${moveSequence}`;
}

async function withTimeout(timeoutMs, fn) {
  let timeout;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for CDP command.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function startHeartbeat(peer, backend) {
  chrome.alarms.create(HEARTBEAT_ALARM_NAME, { periodInMinutes: 0.5 }).catch(() => {});
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM_NAME) {
      safeSendNotification(peer, "heartbeat", { at: new Date().toISOString() });
      void backend.getInfo().catch(() => {});
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { extensionInstanceId } = await chrome.storage.local.get("extensionInstanceId");
  if (typeof extensionInstanceId !== "string") {
    await chrome.storage.local.set({ extensionInstanceId: crypto.randomUUID() });
  }
});

const backend = new BrowserBackend();
const transport = new NativeTransport(NATIVE_HOST_NAME);
const peer = new JsonRpcPeer(transport, backend);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_NATIVE_HOST_STATUS") {
    const status = transport.getStatus();
    sendResponse({ ok: status.state === "connected", status, error: status.error });
    return true;
  }
  if (message?.type === "GET_OPERON_BROWSER_USE_CURSOR_STATE") {
    const tabId = typeof sender.tab?.id === "number" ? sender.tab.id : -1;
    sendResponse({ ok: true, state: backend.readCursorOverlayState(tabId) });
    return true;
  }
  if (message?.type === "OPERON_BROWSER_USE_CURSOR_ARRIVED") {
    sendResponse({ ok: backend.notifyCursorArrived(message) });
    return true;
  }
  return false;
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  backend.handleCdpEvent(source, method, params);
  safeSendNotification(peer, "onCDPEvent", { source, method, params });
});
// Tell the client when Chrome detaches the debugger, so it forgets the tab and re-attaches
// on the next call instead of sending CDP to a tab we are no longer attached to. Upstream
// (obu) dropped this; the official extension forwards the raw source object, and the client
// reads source.tabId from it. Without it, an external detach leaves the client stuck sending
// to a dead attachment until the turn ends. This is a second listener alongside the backend's
// own, matching the official layout: the backend clears its state, this notifies the client.
chrome.debugger.onDetach.addListener((source) => {
  safeSendNotification(peer, "onCDPDetach", source);
});
backend.addDownloadChangeListener((change) => {
  safeSendNotification(peer, "onDownloadChange", change);
});
chrome.downloads.onCreated.addListener((item) => {
  backend.handleDownloadCreated(item);
});
chrome.downloads.onChanged.addListener((delta) => {
  backend.handleDownloadChanged(delta);
});
startHeartbeat(peer, backend);

function safeSendNotification(peer, method, params) {
  try {
    peer.sendNotification(method, params);
  } catch {}
}
