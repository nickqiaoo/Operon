import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { JsonRpcPeer, type RpcHandler } from "./JsonRpcPeer.ts";
import { authorizePeer } from "./peer-auth.ts";
import {
  backendSocketDir,
  backendSocketPath,
  OPERON_BUILD_FLAVOR,
  type BrowserInfo,
} from "./wire.ts";

/**
 * The IAB backend: serves the Operon Browser Use wire contract on
 * `/tmp/operon-browser-use/<id>.sock`, turning each RPC into CDP calls against
 * the browser the user can actually see.
 *
 * The layering keeps this package framework-agnostic:
 *   IabBackend        wire and protocol. Plain Node, testable.
 *      | CdpDriver (interface)
 *   Electron binding  webContents.debugger.sendCommand
 *
 * So the protocol layer never depends on Electron, tests can inject a fake
 * driver, and the real one is injected in the main process.
 */

/**
 * The capabilities the backend needs to drive a browser, implemented by the host
 * (on Electron, `webContents.debugger`). This is the minimum surface needed to
 * work end to end; more methods land as they are required.
 */
/**
 * The shape of a tab on the wire: `{ id, title, active, url }`, where `active`
 * means this tab is the selected one. `active` is easy to forget and its absence
 * is not obviously wrong, so it is called out here.
 */
export interface BrowserUseTab {
  /**
   * A number, never a string.
   *
   * There are two layers of id here, and the string at the model layer is
   * misleading: the wire speaks numbers, while the model-facing tool layer
   * converts them to strings on the way out and back to numbers on the way in.
   *
   * Returning `"5"` on the wire looks fine at the model layer, because
   * `.toString()` on a string is a no-op. But the client converts `tab_id` back
   * to the number `5` and then looks it up with `getTabs().find(o => o.id === 5)`.
   * `"5" === 5` is false, so it reports `Tab not found: 5. Existing tabs: 5||`,
   * naming a tab that is visibly in the list.
   */
  id: number;
  title: string;
  url: string;
  /** Whether this is the currently selected tab. Selection is tracked per route. */
  active: boolean;
  /**
   * Which conversation's browser this tab belongs to (operon's chatId).
   *
   * A design that gives every conversation its own browser host gets ownership
   * for free, and enforces it by refusing any tab whose route does not match the
   * session's. Operon's browser panel also swaps contents per conversation, but
   * serves them all from one host, so ownership is recorded explicitly instead.
   *
   * `undefined` means unowned, either historical or opened while no conversation
   * was active, and no session can see it.
   */
  owner?: string;
}

/**
 * Where a CDP event came from.
 *
 * A debugger message arrives as (event, method, params, sessionId). A non-empty
 * sessionId identifies a child target and resolves to its targetId; the top-level
 * tab has neither. Those three make up the source of the emitted event.
 */
export interface CdpEventSource {
  /**
   * Must be a number, never a string. The client only recognises an event whose
   * `tabId` is typeof "number"; a string like `"7"` misses that branch, the
   * lookup returns undefined, and the event is dropped silently. The symptom is
   * `goto()` timing out with no other clue. (tabId is a number on the wire
   * anyway; see BrowserUseTab.id.)
   */
  tabId: number;
  /** CDP session of a child target such as an OOPIF or iframe. */
  sessionId?: string;
  targetId?: string;
}

export interface CdpEvent {
  source: CdpEventSource;
  method: string;
  params?: unknown;
}

/** Size, in CSS pixels, of the real paint surface temporarily given to a parked
 *  webview. */
export interface CaptureSurfaceSize {
  width: number;
  height: number;
}

export interface BrowserUseCursor {
  x: number;
  y: number;
}

export type BrowserUseDownloadStatus =
  | "started"
  | "in_progress"
  | "complete"
  | "canceled"
  | "failed";

export interface BrowserUseDownloadChange {
  filename: string;
  id: string;
  session_id: string;
  status: BrowserUseDownloadStatus;
  url: string;
}

export interface CdpDriver {
  /** Attach the debugger to a tab (on Electron, `webContents.debugger.attach()`). */
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  /**
   * Subscribe to CDP events; returns an unsubscribe function.
   *
   * Leaving this unimplemented makes `goto()`, `waitForPageLoadEvent` and
   * anything like them time out. After sending `Page.navigate` the client does
   * not poll `href`; it waits for one of `Page.frameStartedLoading`,
   * `Page.frameNavigated` or `Page.navigatedWithinDocument`. Commands still go
   * out and results still come back, so the only symptom is that "has it
   * navigated yet" is never answered.
   *
   * On Electron this is
   * `webContents.debugger.on("message", (e, method, params, sessionId) => …)`.
   */
  onCdpEvent?(cb: (evt: CdpEvent) => void): () => void;
  /** Electron download lifecycle -> wire notification `onDownloadChange`. */
  onDownloadChange?(cb: (change: BrowserUseDownloadChange) => void): () => void;
  /**
   * Send one CDP command (on Electron, `webContents.debugger.sendCommand()`).
   *
   * `sessionId` is the third argument of `sendCommand(method, params, sessionId)`
   * and targets a child target such as an OOPIF or cross-origin iframe. When only
   * a targetId is known it is resolved to its session first. The top-level tab
   * passes neither.
   */
  sendCommand(tabId: number, method: string, params?: unknown, sessionId?: string): Promise<unknown>;
  /**
   * Temporarily give a tab a real paint surface before a full-page or clipped
   * screenshot. `null` removes it and restores the previous visible or parked state.
   *
   * Only `Page.captureScreenshot` with `captureBeyondViewport: true` and a valid
   * `clip` needs this. It is not a device metrics override: the host has to make
   * the webview genuinely paint at that size, or an invisible guest produces no
   * frames and `captureScreenshot` still reports zero width or never returns.
   */
  setCaptureSurface?(tabId: number, size: CaptureSurfaceSize | null): Promise<void>;
  /**
   * While Browser Use holds a tab, keep a low-opacity paint host for it even when
   * it is not in the foreground, so an ordinary viewport screenshot (which carries
   * no full-page clip and therefore never takes the capture-surface path) still
   * produces frames.
   */
  setBrowserUseActive?(tabId: number, active: boolean): Promise<void>;
  /** Browser Use cursor overlay. `null` removes it when control is released. */
  setCursor?(tabId: number, cursor: BrowserUseCursor | null): Promise<void>;
  /** One-shot grant consumed by Electron's next matching `will-download`. */
  allowDownload?(tabId: number, url: string, sessionId: string): Promise<void>;
  /** Browser-level capabilities exposed by getInfo(). */
  setVisible?(tabId: number, visible: boolean): Promise<void>;
  isVisible?(tabId: number): Promise<boolean>;
  setViewport?(tabId: number, size: CaptureSurfaceSize | null): Promise<void>;
  /** Select an already-existing user tab after claimUserTab. */
  selectTab?(tabId: number): Promise<void>;
  /** Every tab in the browser, including ones the user opened. Ownership is
   *  IabBackend's concern, not the driver's. */
  listTabs(): Promise<BrowserUseTab[]>;
  /**
   * Open a new tab and return it. An empty `url` opens a blank page.
   * `owner` is the requesting conversation (chatId), so the tab lands in that
   * conversation's browser panel.
   */
  createTab(url: string | undefined, owner: string): Promise<BrowserUseTab>;
  /** Actually close a tab. */
  closeTab(tabId: number): Promise<void>;
}

/** Where a tab came from: `agent` if the agent opened it, `user` if the user did
 *  or if it has been released back to the pool. */
export type TabOrigin = "agent" | "user";

/** `markTab` accepts only these two values. */
export type TabStatus = "handoff" | "deliverable";

/** A tab currently leased by a session. */
interface LeasedTab {
  origin: TabOrigin;
  status?: TabStatus;
  /** `turnEnded` only consumes marks made by the same turn. */
  markTurnId?: string;
}

export interface IabBackendOptions {
  driver: CdpDriver;
  /**
   * Pin this backend to one session id. Normally leave it unset: unset means echo
   * mode, where a single backend serves every session.
   *
   * ## Why echo mode works
   *
   * The SDK filters IAB backends on `metadata.operonSessionId` and actively
   * `close()`s any that does not match the current session. That looks like it
   * forces one backend per session.
   *
   * It does not, because `getInfo` is itself a session request: the client merges
   * its session params into every call, so the request already carries
   * `{session_id, turn_id, session_context}`. The backend therefore knows who is
   * asking and can echo that session id straight back, which matches for every
   * session and so is never closed.
   *
   * The `session_id` in those params is already resolved (a subagent has been
   * mapped to its thread_id upstream), so echoing it is correct without having to
   * reason about subagents here.
   *
   * Every subsequent RPC carries `session_id` too, which is how one backend can
   * still divide tab ownership per session internally.
   *
   * The result is that operon needs exactly one backend: one browser in the
   * desktop app, one backend, and no lifecycle question about who creates or
   * destroys it and when.
   */
  sessionId?: string;
  /** Unique id used in the socket filename; random by default. */
  id?: string;
  /** `getInfo().name`, for display. */
  name?: string;
  /**
   * `metadata.operonBuildFlavor`, defaulting to `OPERON_BUILD_FLAVOR`. This is the
   * IAB runtime identity: clients check it against
   * `OPERON_BROWSER_USE_BUILD_FLAVOR` for IAB backends only, and the Chrome
   * extension takes no part in that filter.
   *
   * Production uses `operon` throughout; overriding it is mainly for test isolation.
   */
  buildFlavor?: string;
  /**
   * Extra fields for `getInfo().metadata`. `operonSessionId` is written from
   * `sessionId` automatically.
   * Values must be strings; the schema is a record of strings.
   */
  metadata?: Record<string, string>;
  /** Override the socket directory, for tests. Defaults to `/tmp/operon-browser-use`. */
  socketDir?: string;
}

const randomId = () => Math.random().toString(36).slice(2, 10);

const BROWSER_CAPABILITIES = [
  {
    id: "visibility",
    description:
      "Use to show or hide the browser to the user, and to determine the browser's current visibility. Keep browser work in the background unless the user asks to see it or live viewing is useful. When the browser should be visible, call set(true).",
  },
  {
    id: "viewport",
    description:
      "Controls an explicit browser viewport override for responsive or device-size testing. Use it when a task calls for specific dimensions or breakpoint validation; otherwise leave it unset so the browser uses its normal viewport. Reset temporary overrides before finishing unless the user asked to keep them.",
  },
];

export class IabBackend {
  private server: net.Server | null = null;
  /**
   * Live connections. close() has to destroy them itself: `net.Server.close()`
   * only stops accepting new connections and then waits for existing ones to end
   * on their own. Clients here hold long-lived connections, so without this the
   * server never closes.
   */
  private readonly sockets = new Set<net.Socket>();
  /**
   * The peer on each connection, plus the session_id its most recent request
   * carried.
   *
   * Tracking the session matters because CDP events would otherwise be broadcast.
   * That is fine for a backend serving exactly one session, but this one runs in
   * echo mode and serves them all, so a broadcast would deliver events from one
   * conversation's page (whose `params` can contain page content) into another
   * conversation's kernel process. The receiving client would discard them for
   * not matching its attached tabs, but the data would already have crossed.
   * Hence the filter by lease.
   */
  private readonly peers = new Map<net.Socket, { peer: JsonRpcPeer; sessionId?: string }>();
  /** Unsubscribe function for the driver's event subscription; called on close. */
  private unsubscribeCdpEvents: (() => void) | null = null;
  private unsubscribeDownloadChanges: (() => void) | null = null;
  private readonly id: string;
  private socketPath = "";

  /**
   * The tab lease ledger: sessionId -> (tabId -> lease).
   *
   * A tab is either leased by exactly one session or sitting in the user pool,
   * which simply means it appears in no session's ledger.
   *   - `claimUserTab` moves it from the pool to a session.
   *   - `releaseTab` moves it back to the pool. It does not close it.
   *   - `closeTab` genuinely destroys it, and only for tabs the agent opened and
   *     has not marked.
   *
   * This ledger is the entire basis on which several conversations and the user
   * can share one browser without fighting over it.
   */
  private readonly leases = new Map<string, Map<number, LeasedTab>>();
  /** sessionId -> session name, used as the heading when tabs are grouped. */
  private readonly sessionNames = new Map<string, string>();
  /** targetId -> flattened CDP sessionId, partitioned by top-level tab. */
  private readonly targetSessionsByTabId = new Map<number, Map<string, string>>();
  private readonly targetBySessionId = new Map<string, { tabId: number; targetId: string }>();
  /** Official client's optional Runtime.evaluate expression cache. */
  private readonly cachedCdpExpressions = new Map<string, string>();
  /** Capability calls may arrive before tabs.new(); Codex keeps these as route intents. */
  private readonly pendingVisibleSessions = new Set<string>();
  private readonly pendingViewportBySession = new Map<string, CaptureSurfaceSize>();
  /** Sessions whose unexpected disconnect is still being cleaned up. A reconnect
   *  waits for the old paint-host teardown so a stale false cannot overwrite a
   *  fresh true. */
  private readonly disconnectedSessionReleases = new Map<string, Promise<void>>();

  private leaseOf(sessionId: string): Map<number, LeasedTab> {
    let m = this.leases.get(sessionId);
    if (!m) this.leases.set(sessionId, (m = new Map()));
    return m;
  }

  /**
   * The gate on every driving operation: this session must hold a lease on this
   * tab.
   *
   * Without it the lease model is decorative. `getTabs` and `claimUserTab` check
   * ownership, but if `attach`, `detach` and `executeCdp` do not, any session
   * that names a tabId can drive *any* registered tab, including ones the user
   * never handed to an agent, such as a signed-in banking page. And tabId is
   * `webContents.id`, a small integer that costs nothing to enumerate:
   *
   *   executeCdp({target:{tabId:3}, method:"Runtime.evaluate",
   *               commandParams:{expression:"document.cookie"}})
   *
   * A per-session backend can afford one gate at the door, because a session that
   * reaches the backend at all is by construction the right one. In echo mode
   * there is no door, so the per-tab check is the only gate there is.
   */
  private requireLeased(sessionId: string, tabId: number): void {
    if (!this.leaseOf(sessionId).has(tabId)) {
      throw new Error(`Tab ${tabId} is not part of this browser session`);
    }
  }

  /** Whether any session holds a lease on this tab, which is what decides
   *  whether it is in the user pool. */
  private isLeasedByAnyone(tabId: number): boolean {
    for (const m of this.leases.values()) if (m.has(tabId)) return true;
    return false;
  }

  /**
   * The client's socket is the liveness signal for a session. When its last
   * connection drops, every tab that session held goes back to the user pool.
   * This is unexpected-disconnect cleanup, so it only detaches and clears the
   * ledger; it never closes a page. Orderly shutdown is still `finalizeTabs`'s
   * job, and that is what decides which agent tabs should close.
   */
  private releaseDisconnectedSession(sessionId: string): void {
    for (const entry of this.peers.values()) {
      if (entry.sessionId === sessionId) return;
    }
    const lease = this.leases.get(sessionId);
    if (lease == null) return;
    // Clear the ledger first. A reconnect briefly waits on the best-effort
    // cleanup below, so a late `active: false` cannot park a tab that a new
    // kernel has just reclaimed and set active.
    this.leases.delete(sessionId);
    this.sessionNames.delete(sessionId);
    this.pendingVisibleSessions.delete(sessionId);
    this.pendingViewportBySession.delete(sessionId);
    const release = Promise.allSettled(
      [...lease.keys()].map(async (tabId) => {
        await this.opts.driver.detach(tabId).catch(() => {});
        this.forgetTargetSessionsForTab(tabId);
        await this.opts.driver.setCursor?.(tabId, null).catch(() => {});
        await this.opts.driver.setBrowserUseActive?.(tabId, false).catch(() => {});
      }),
    ).then(() => {});
    this.disconnectedSessionReleases.set(sessionId, release);
    void release.finally(() => {
      if (this.disconnectedSessionReleases.get(sessionId) === release) {
        this.disconnectedSessionReleases.delete(sessionId);
      }
    });
  }

  private async waitForDisconnectedSessionRelease(sessionId: string): Promise<void> {
    await this.disconnectedSessionReleases.get(sessionId);
  }

  private rememberTargetSession(tabId: number, targetId: string, sessionId: string): void {
    let byTarget = this.targetSessionsByTabId.get(tabId);
    if (byTarget == null) {
      byTarget = new Map();
      this.targetSessionsByTabId.set(tabId, byTarget);
    }
    byTarget.set(targetId, sessionId);
    this.targetBySessionId.set(sessionId, { tabId, targetId });
  }

  private forgetTargetSession(sessionId: string): void {
    const target = this.targetBySessionId.get(sessionId);
    if (target == null) return;
    this.targetBySessionId.delete(sessionId);
    const byTarget = this.targetSessionsByTabId.get(target.tabId);
    byTarget?.delete(target.targetId);
    if (byTarget?.size === 0) this.targetSessionsByTabId.delete(target.tabId);
  }

  private forgetTargetSessionsForTab(tabId: number): void {
    const byTarget = this.targetSessionsByTabId.get(tabId);
    if (byTarget == null) return;
    for (const sessionId of byTarget.values()) this.targetBySessionId.delete(sessionId);
    this.targetSessionsByTabId.delete(tabId);
  }

  private async activeTabId(sessionId: string): Promise<number | null> {
    const lease = this.leases.get(sessionId);
    if (lease == null || lease.size === 0) return null;
    const tabs = (await this.opts.driver.listTabs()).filter((tab) => lease.has(tab.id));
    return (tabs.find((tab) => tab.active) ?? tabs[0])?.id ?? null;
  }

  private async applyPendingCapabilities(sessionId: string, tabId: number): Promise<void> {
    const viewport = this.pendingViewportBySession.get(sessionId);
    if (viewport != null) {
      this.pendingViewportBySession.delete(sessionId);
      await this.opts.driver.setViewport?.(tabId, viewport);
    }
    if (this.pendingVisibleSessions.delete(sessionId)) {
      await this.opts.driver.setVisible?.(tabId, true);
    }
  }

  private readonly opts: IabBackendOptions;

  // No parameter properties: vite treats this package as external, so Node loads
  // the .ts source directly with strip-only type erasure, and a parameter
  // property raises ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. See the external list in
  // vite.config.ts.
  constructor(opts: IabBackendOptions) {
    this.opts = opts;
    this.id = opts.id ?? randomId();
  }

  /** This backend's socket path; only meaningful once listening. */
  get path(): string {
    return this.socketPath;
  }

  /**
   * The `getInfo()` response; see BrowserInfo in wire.ts for the schema.
   * `type: "iab"` is the only thing a client has to tell backends apart, since
   * the IAB backend and the Chrome extension share one socket directory.
   *
   * `params` is the session params the client attached to this `getInfo`
   * (`{session_id, turn_id, session_context}`). In echo mode it supplies
   * `operonSessionId`; see `IabBackendOptions.sessionId`.
   */
  getInfo(params?: unknown): BrowserInfo {
    // Echo the asker's session id straight back, so this backend matches every
    // session and one instance can serve them all. The incoming session_id is
    // already resolved upstream, so subagents are correct without extra work.
    const asked = (params as { session_id?: unknown } | undefined)?.session_id;
    const operonSessionId =
      this.opts.sessionId ?? (typeof asked === "string" ? asked : undefined);
    return {
      id: this.id,
      name: this.opts.name ?? "operon",
      type: "iab",
      // Operon's browser is multi-tab by nature, so it advertises multiTab. In
      // that mode the model-facing API funnels through Tabs.finalize();
      // markDeliverable and markHandoff still exist on the internal class but are
      // hidden from the API view.
      apiSupportOverrides: {
        "BrowserUser.claimTab": true,
        "Tabs.content": true,
        "Tabs.finalize": true,
      },
      capabilities: { browser: BROWSER_CAPABILITIES },
      metadata: {
        operonBuildFlavor: this.opts.buildFlavor ?? OPERON_BUILD_FLAVOR,
        ...this.opts.metadata,
        // The ownership key. The SDK actively closes any IAB backend that does
        // not match the current session.
        ...(operonSessionId ? { operonSessionId } : {}),
      },
    };
  }

  /** Shared implementation for executeCdp and executeCdpWithCachedExpression. */
  private async executeCdpRequest(p: unknown): Promise<unknown> {
    const sessionId = reqSession(p);
    await this.waitForDisconnectedSessionRelease(sessionId);
    const { target, method, commandParams } = (p ?? {}) as {
      target?: { tabId?: unknown; targetId?: unknown; sessionId?: unknown };
      method?: string;
      commandParams?: unknown;
    };
    if (typeof method !== "string") throw new Error("executeCdp requires method");

    let tabId: number;
    if (target?.tabId != null) {
      tabId = reqTabId(target);
      this.requireLeased(sessionId, tabId);
    } else {
      // Codex only auto-bootstraps a missing tab for Page.navigate with a string URL,
      // and only when this session has no selected/leased tab yet.
      const url =
        method === "Page.navigate" && isRecord(commandParams)
          ? commandParams.url
          : undefined;
      if (typeof url !== "string" || (await this.activeTabId(sessionId)) != null) {
        throw new Error("executeCdp requires a tabId target");
      }
      const tab = await this.opts.driver.createTab(undefined, sessionId);
      tabId = tab.id;
      this.leaseOf(sessionId).set(tabId, { origin: "agent" });
      try {
        await this.opts.driver.setBrowserUseActive?.(tabId, true);
        await this.applyPendingCapabilities(sessionId, tabId);
      } catch (error) {
        this.leaseOf(sessionId).delete(tabId);
        await this.opts.driver.closeTab(tabId).catch(() => {});
        throw error;
      }
    }

    const explicitSessionId =
      typeof target?.sessionId === "string" ? target.sessionId : undefined;
    const targetId = typeof target?.targetId === "string" ? target.targetId : undefined;
    const targetSessionId =
      explicitSessionId ??
      (targetId == null ? undefined : this.targetSessionsByTabId.get(tabId)?.get(targetId));
    if (targetId != null && targetSessionId == null) {
      throw new Error(`No in-app browser debugger session is attached for target ${targetId}`);
    }
    await this.opts.driver.setBrowserUseActive?.(tabId, true);
    return await executeCdpCommandWithCaptureSurface(
      this.opts.driver,
      tabId,
      method,
      commandParams ?? {},
      targetSessionId,
    );
  }

  /**
   * Current Browser client sends `Tabs.content()` through
   * `executeUnhandledCommand({type:"tabs_content", ...})`. The backend owns the
   * temporary tabs so the selected user tab can be restored before returning.
   */
  private async tabsContent(p: unknown): Promise<{
    results: Array<{ content: string | null; title: string | null; url: string }>;
  }> {
    const sessionId = reqSession(p);
    await this.waitForDisconnectedSessionRelease(sessionId);
    if (!isRecord(p) || !Array.isArray(p.urls) || p.urls.some((url) => typeof url !== "string")) {
      throw new Error("tabs_content requires an array of URLs");
    }
    const contentType = p.content_type;
    if (contentType !== "html" && contentType !== "text" && contentType !== "domSnapshot") {
      throw new Error('tabs_content content_type must be "html", "text", or "domSnapshot"');
    }
    const timeoutMs = p.timeout_ms ?? 30_000;
    if (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0) {
      throw new Error("tabs_content timeout_ms must be a positive integer");
    }

    const driver = this.opts.driver;
    const selectedBefore = (await driver.listTabs()).find(
      (tab) => tab.active && tab.owner === sessionId,
    )?.id;
    const results: Array<{ content: string | null; title: string | null; url: string }> = [];
    for (const requestedUrl of p.urls as string[]) {
      let tab: BrowserUseTab | undefined;
      try {
        tab = await driver.createTab(undefined, sessionId);
        this.leaseOf(sessionId).set(tab.id, { origin: "agent" });
        await driver.setBrowserUseActive?.(tab.id, true);
        await driver.attach(tab.id);
        await driver.sendCommand(tab.id, "Page.enable", {});
        await driver.sendCommand(tab.id, "Runtime.enable", {});
        await withTimeout(
          driver.sendCommand(tab.id, "Page.navigate", { url: requestedUrl }),
          timeoutMs as number,
          `Timed out navigating temporary tab to ${requestedUrl}`,
        );
        const state = await waitForDocumentReady(
          driver,
          tab.id,
          timeoutMs as number,
        );
        const extracted = await withTimeout(
          driver.sendCommand(tab.id, "Runtime.evaluate", {
            expression: tabsContentExpression(contentType),
            returnByValue: true,
          }),
          timeoutMs as number,
          `Timed out extracting ${contentType} content from ${requestedUrl}`,
        );
        const content = cdpResultValue(extracted);
        results.push({
          content: typeof content === "string" ? content : null,
          title: state.title ?? null,
          url: state.href ?? requestedUrl,
        });
      } catch {
        results.push({ content: null, title: null, url: requestedUrl });
      } finally {
        if (tab != null) {
          await driver.detach(tab.id).catch(() => {});
          this.forgetTargetSessionsForTab(tab.id);
          await driver.setBrowserUseActive?.(tab.id, false).catch(() => {});
          await driver.closeTab(tab.id).catch(() => {});
          const lease = this.leases.get(sessionId);
          lease?.delete(tab.id);
          if (lease?.size === 0) this.leases.delete(sessionId);
        }
        if (selectedBefore != null) await driver.selectTab?.(selectedBefore).catch(() => {});
      }
    }
    return { results };
  }

  private handlers(): Record<string, RpcHandler> {
    const { driver } = this.opts;
    return {
      ping: () => "pong",
      // Pass params through: echo mode reads the asker's session_id from it.
      getInfo: (p) => this.getInfo(p),

      attach: async (p) => {
        const tabId = reqTabId(p);
        this.requireLeased(reqSession(p), tabId);
        await driver.attach(tabId);
        return null;
      },
      attachTarget: async (p) => {
        const sessionId = reqSession(p);
        const tabId = reqTabId(p);
        this.requireLeased(sessionId, tabId);
        const targetId = reqNonEmptyString(p, "targetId", "attachTarget");
        const parentTargetId =
          isRecord(p) && typeof p.parentTargetId === "string"
            ? p.parentTargetId
            : undefined;
        await driver.attach(tabId);
        if (this.targetSessionsByTabId.get(tabId)?.has(targetId)) return null;
        const parentSessionId =
          parentTargetId == null
            ? undefined
            : this.targetSessionsByTabId.get(tabId)?.get(parentTargetId);
        if (parentTargetId != null && parentSessionId == null) {
          throw new Error(`No in-app browser debugger session is attached for parent target ${parentTargetId}`);
        }
        const result = await driver.sendCommand(tabId, "Target.attachToTarget", {
          flatten: true,
          targetId,
        }, parentSessionId);
        const debuggerSessionId =
          isRecord(result) && typeof result.sessionId === "string"
            ? result.sessionId
            : null;
        if (debuggerSessionId == null) {
          throw new Error("Target.attachToTarget did not return a sessionId");
        }
        this.rememberTargetSession(tabId, targetId, debuggerSessionId);
        return null;
      },
      detach: async (p) => {
        const tabId = reqTabId(p);
        this.requireLeased(reqSession(p), tabId);
        await driver.detach(tabId);
        this.forgetTargetSessionsForTab(tabId);
        return null;
      },
      detachTarget: async (p) => {
        const tabId = reqTabId(p);
        this.requireLeased(reqSession(p), tabId);
        const targetId = reqNonEmptyString(p, "targetId", "detachTarget");
        const debuggerSessionId = this.targetSessionsByTabId.get(tabId)?.get(targetId);
        if (debuggerSessionId == null) return null;
        try {
          await driver.sendCommand(tabId, "Target.detachFromTarget", {
            sessionId: debuggerSessionId,
          });
        } finally {
          this.forgetTargetSession(debuggerSessionId);
        }
        return null;
      },
      executeCdp: (p) => this.executeCdpRequest(p),

      executeCdpWithCachedExpression: async (p) => {
        if (!isRecord(p) || typeof p.expressionCacheKey !== "string") {
          throw new Error("executeCdpWithCachedExpression requires expressionCacheKey");
        }
        const params = isRecord(p.commandParams) ? p.commandParams : {};
        const supplied = typeof params.expression === "string" ? params.expression : undefined;
        if (supplied != null) this.cachedCdpExpressions.set(p.expressionCacheKey, supplied);
        const expression = supplied ?? this.cachedCdpExpressions.get(p.expressionCacheKey);
        if (expression == null) return { kind: "cache-miss" };
        const result = await this.executeCdpRequest({
          ...p,
          commandParams: { ...params, expression },
        });
        return { kind: "executed", result };
      },

      // Every tab method below returns a bare array, never `{tabs: […]}`.
      // `getTabsForBrowserUse()`: `return t.map(e => this.serializeTab(e))`。
      // Wrapping it makes the client fail with
      // `(intermediate value).map is not a function`.

      /** Tabs leased by *this session*, not every tab in the browser. */
      getTabs: async (p) => {
        const sessionId = reqSession(p);
        await this.waitForDisconnectedSessionRelease(sessionId);
        const lease = this.leaseOf(sessionId);
        return (await driver.listTabs()).filter((t) => lease.has(t.id));
      },

      /**
       * The user pool: tabs in *this conversation's* browser that no agent has
       * claimed yet, meaning the ones the user opened.
       *
       * Filtering by owner is required. The browser panel switches per
       * conversation, and an agent in one conversation must not see, let alone
       * claim, a page belonging to another. A design with one browser host per
       * conversation gets that isolation for free; this one serves them all from
       * a single host, so the filter has to be explicit.
       */
      getUserTabs: async (p) => {
        const sessionId = reqSession(p);
        await this.waitForDisconnectedSessionRelease(sessionId);
        return (await driver.listTabs()).filter(
          (t) => t.owner === sessionId && !this.isLeasedByAnyone(t.id),
        );
      },

      createTab: async (p) => {
        const sessionId = reqSession(p);
        await this.waitForDisconnectedSessionRelease(sessionId);
        const { url } = (p ?? {}) as { url?: string };
        // owner is this session, so the new tab appears in this conversation's panel.
        const tab = await driver.createTab(typeof url === "string" ? url : undefined, sessionId);
        // origin "agent" means finalize should close it unless it was marked.
        const lease = this.leaseOf(sessionId);
        lease.set(tab.id, { origin: "agent" });
        // Creating a tab also marks it browser-use active: a background tab still
        // has to produce frames, or an ordinary viewport screenshot, which never
        // takes the temporary capture-surface path, can come back zero width.
        try {
          await driver.setBrowserUseActive?.(tab.id, true);
          await this.applyPendingCapabilities(sessionId, tab.id);
        } catch (error) {
          lease.delete(tab.id);
          if (lease.size === 0) this.leases.delete(sessionId);
          throw error;
        }
        return tab;
      },

      closeTab: async (p) => {
        const sessionId = reqSession(p);
        const tabId = reqTabId(p);
        const lease = this.leases.get(sessionId);
        const held = lease?.get(tabId);
        if (held == null) {
          throw new Error(`Tab ${tabId} is not part of this browser session`);
        }
        await driver.detach(tabId).catch(() => {});
        this.forgetTargetSessionsForTab(tabId);
        await driver.setCursor?.(tabId, null).catch(() => {});
        await driver.setBrowserUseActive?.(tabId, false).catch(() => {});
        if (held.origin === "agent") {
          await driver.closeTab(tabId);
        }
        lease?.delete(tabId);
        if (lease?.size === 0) this.leases.delete(sessionId);
        return null;
      },

      /**
       * Claim a tab the user already opened. Only available on a multi-tab
       * backend; a single-tab one rejects it.
       */
      claimUserTab: async (p) => {
        const sessionId = reqSession(p);
        await this.waitForDisconnectedSessionRelease(sessionId);
        const tabId = reqTabId(p);
        const all = await driver.listTabs();
        const tab = all.find((t) => t.id === tabId);
        if (!tab) throw new Error(`Unknown tabId: ${tabId}`);
        // Only tabs in this conversation's browser may be claimed.
        if (tab.owner !== sessionId) {
          throw new Error(`Tab ${tabId} is not part of this browser session`);
        }
        if (this.isLeasedByAnyone(tabId)) {
          // Two sessions must never contend for one tab; that is what the lease
          // model exists for.
          throw new Error(`Tab ${tabId} is already claimed by another browser session`);
        }
        // origin "user" means finalize releases it and never closes it: it is the
        // user's tab.
        const lease = this.leaseOf(sessionId);
        lease.set(tabId, { origin: "user" });
        try {
          await driver.selectTab?.(tabId);
          await driver.setBrowserUseActive?.(tabId, true);
          await this.applyPendingCapabilities(sessionId, tabId);
        } catch (error) {
          lease.delete(tabId);
          if (lease.size === 0) this.leases.delete(sessionId);
          throw error;
        }
        return tab;
      },

      /**
       * Mark what should become of a tab. Requires an integer tabId, and a status
       * of either "handoff" or "deliverable".
       */
      markTab: async (p) => {
        const sessionId = reqSession(p);
        const tabId = reqTabId(p);
        const { status } = (p ?? {}) as { status?: unknown };
        if (status !== "handoff" && status !== "deliverable") {
          throw new Error(`markTab requires status "handoff" or "deliverable"`);
        }
        const lease = this.leaseOf(sessionId).get(tabId);
        if (!lease) throw new Error(`Tab ${tabId} is not part of this browser session`);
        lease.status = status;
        lease.markTurnId = reqOptionalString(p, "turn_id");
        return null;
      },

      /**
       * Hand tabs back at the end of a turn. The rules, in full:
       *
       *   - opened by the agent and never marked  ->  close it
       *   - the user's tab                        ->  release, never close
       *   - marked handoff or deliverable         ->  release and leave it for
       *                                               the user
       */
      finalizeTabs: async (p) => {
        const sessionId = reqSession(p);
        const { keep } = (p ?? {}) as { keep?: unknown };
        if (!Array.isArray(keep)) throw new Error("finalizeTabs requires a keep array");
        const keepMap = parseKeep(keep);
        const lease = this.leaseOf(sessionId);
        const retained = new Map<number, LeasedTab>();

        await Promise.allSettled(
          [...lease.entries()].map(async ([tabId, held]) => {
            // Detach the debugger first, best effort.
            await driver.detach(tabId).catch(() => {});
            this.forgetTargetSessionsForTab(tabId);
            await driver.setCursor?.(tabId, null).catch(() => {});
            await driver.setBrowserUseActive?.(tabId, false).catch(() => {});
            const marked = keepMap.get(tabId) ?? held.status;
            if (marked === "handoff" && held.origin === "agent") {
              retained.set(tabId, { origin: "agent" });
              return;
            }
            if (marked === "handoff" || marked === "deliverable" || held.origin !== "agent") {
              return; // Released: clearing the ledger below is enough; the tab stays.
            }
            await driver.closeTab(tabId).catch(() => {});
          }),
        );
        // agent handoff stays attached to this browser session; everything else
        // was released to the user pool or closed above.
        if (retained.size === 0) this.leases.delete(sessionId);
        else this.leases.set(sessionId, retained);
        this.pendingVisibleSessions.delete(sessionId);
        this.pendingViewportBySession.delete(sessionId);
        return null;
      },

      /** Name a session; used as the heading when tabs are grouped. Stored for now,
       *  pending UI. */
      nameSession: async (p) => {
        const sessionId = reqSession(p);
        const { name } = (p ?? {}) as { name?: unknown };
        if (typeof name === "string") this.sessionNames.set(sessionId, name);
        return null;
      },

      moveMouse: async (p) => {
        const sessionId = reqSession(p);
        const tabId = reqTabId(p);
        this.requireLeased(sessionId, tabId);
        if (!isRecord(p) || !isFiniteNumber(p.x) || !isFiniteNumber(p.y)) {
          throw new Error("moveMouse requires finite x and y coordinates");
        }
        if (p.waitForArrival != null && typeof p.waitForArrival !== "boolean") {
          throw new Error("moveMouse waitForArrival must be a boolean");
        }
        await driver.setBrowserUseActive?.(tabId, true);
        await driver.setCursor?.(tabId, { x: p.x, y: p.y });
        return null;
      },

      allowDownload: async (p) => {
        const sessionId = reqSession(p);
        const tabId = reqTabId(p);
        this.requireLeased(sessionId, tabId);
        const url = reqNonEmptyString(p, "url", "allowDownload");
        if (driver.allowDownload == null) {
          throw new Error("Downloads are not supported by this in-app browser");
        }
        await driver.allowDownload(tabId, url, sessionId);
        return null;
      },

      executeUnhandledCommand: async (p) => {
        const sessionId = reqSession(p);
        const type = reqNonEmptyString(p, "type", "executeUnhandledCommand");
        if (type === "tabs_content") {
          return await this.tabsContent(p);
        }
        const tabId = await this.activeTabId(sessionId);
        if (type === "browser_visibility_set") {
          if (!isRecord(p) || typeof p.visible !== "boolean") {
            throw new Error("browser_visibility_set requires visible");
          }
          if (tabId == null) {
            if (p.visible) this.pendingVisibleSessions.add(sessionId);
            else this.pendingVisibleSessions.delete(sessionId);
          } else {
            await driver.setVisible?.(tabId, p.visible);
          }
          return {};
        }
        if (type === "browser_visibility_get") {
          return {
            visible:
              tabId != null && driver.isVisible != null
                ? await driver.isVisible(tabId)
                : false,
          };
        }
        if (type === "browser_viewport_set") {
          if (
            !isRecord(p) ||
            !Number.isInteger(p.width) ||
            !Number.isInteger(p.height) ||
            (p.width as number) <= 0 ||
            (p.height as number) <= 0
          ) {
            throw new Error("browser_viewport_set requires positive integer width and height");
          }
          const size = { width: p.width as number, height: p.height as number };
          if (tabId == null) this.pendingViewportBySession.set(sessionId, size);
          else await driver.setViewport?.(tabId, size);
          return {};
        }
        if (type === "browser_viewport_reset") {
          this.pendingViewportBySession.delete(sessionId);
          if (tabId != null) await driver.setViewport?.(tabId, null);
          return {};
        }
        throw new Error(`Operon in-app browser does not support command "${type}".`);
      },

      turnEnded: async (p) => {
        const sessionId = reqSession(p);
        const turnId = reqNonEmptyString(p, "turn_id", "turnEnded");
        const lease = this.leases.get(sessionId);
        if (lease == null) return null;
        const retained = new Map<number, LeasedTab>();
        await Promise.allSettled(
          [...lease.entries()].map(async ([tabId, held]) => {
            await driver.detach(tabId).catch(() => {});
            this.forgetTargetSessionsForTab(tabId);
            await driver.setCursor?.(tabId, null).catch(() => {});
            await driver.setBrowserUseActive?.(tabId, false).catch(() => {});
            const marked = held.markTurnId === turnId ? held.status : undefined;
            if (marked === "handoff" && held.origin === "agent") {
              retained.set(tabId, { origin: "agent" });
              return;
            }
            if (marked != null || held.origin !== "agent") return;
            await driver.closeTab(tabId).catch(() => {});
          }),
        );
        if (retained.size === 0) this.leases.delete(sessionId);
        else this.leases.set(sessionId, retained);
        this.pendingVisibleSessions.delete(sessionId);
        this.pendingViewportBySession.delete(sessionId);
        return null;
      },

      /**
       * The IAB backend does not support history; this always throws.
       */
      getUserHistory: async (p) => {
        reqSession(p);
        throw new Error("browser.user.history is not available with the in-app browser.");
      },
    };
  }

  /**
   * Wrap the handlers so every request records its `session_id` against the
   * connection it arrived on. Delivering events back needs to know which session
   * a connection belongs to, and only requests carry a session on the wire; the
   * connection itself does not.
   */
  private trackingHandlers(entryOf: () => { sessionId?: string }): Record<string, RpcHandler> {
    const inner = this.handlers();
    const wrapped: Record<string, RpcHandler> = {};
    for (const [name, fn] of Object.entries(inner)) {
      wrapped[name] = (params: unknown) => {
        const sid = (params as { session_id?: unknown } | undefined)?.session_id;
        if (typeof sid === "string") entryOf().sessionId = sid;
        return fn(params);
      };
    }
    return wrapped;
  }

  /**
   * CDP events out to clients, as the JSON-RPC notification `onCDPEvent`.
   *   sendCdpEvent(e){ this.sendNotification(`onCDPEvent`, e) }
   *   sendNotification(e,t){ this.transport.sendMessage({jsonrpc:`2.0`, method:e, params:t}) }
   *
   * A per-session backend can broadcast these; this one filters by lease, since
   * in echo mode a single backend serves many sessions (see the `peers` comment).
   * The tabId on an event is a number while the ledger keys are strings, so it is
   * converted once here.
   */
  private broadcastCdpEvent(evt: CdpEvent): void {
    const tabId = evt.source.tabId;
    if (evt.method === "Target.attachedToTarget" && isRecord(evt.params)) {
      const childSessionId = evt.params.sessionId;
      const targetInfo = evt.params.targetInfo;
      if (
        typeof childSessionId === "string"
        && isRecord(targetInfo)
        && typeof targetInfo.targetId === "string"
      ) {
        this.rememberTargetSession(tabId, targetInfo.targetId, childSessionId);
      }
    }
    const attachedTarget =
      evt.source.sessionId == null
        ? undefined
        : this.targetBySessionId.get(evt.source.sessionId);
    const enriched: CdpEvent =
      evt.source.targetId != null || attachedTarget == null
        ? evt
        : {
            ...evt,
            source: { ...evt.source, targetId: attachedTarget.targetId },
          };
    for (const entry of this.peers.values()) {
      // No session-bearing request has arrived on this connection yet, so there is
      // no way to know who it is. Drop the event: missing one beats crossing
      // sessions.
      if (entry.sessionId == null) continue;
      if (!this.leases.get(entry.sessionId)?.has(tabId)) continue;
      try {
        entry.peer.sendNotification("onCDPEvent", enriched);
      } catch {
        /* A write failing on one connection must not affect the others. */
      }
    }
    if (evt.method === "Target.detachedFromTarget" && isRecord(evt.params)) {
      const detachedSessionId = evt.params.sessionId;
      if (typeof detachedSessionId === "string") this.forgetTargetSession(detachedSessionId);
    }
  }

  private broadcastDownloadChange(change: BrowserUseDownloadChange): void {
    for (const entry of this.peers.values()) {
      if (entry.sessionId !== change.session_id) continue;
      try {
        entry.peer.sendNotification("onDownloadChange", change);
      } catch {
        /* A write failing on one connection must not affect the others. */
      }
    }
  }

  async listen(): Promise<string> {
    const dir = this.opts.socketDir ?? backendSocketDir();
    // The directory has to exist: discovery works by reading it.
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    this.socketPath = this.opts.socketDir
      ? path.join(dir, `${this.id}.sock`)
      : backendSocketPath(this.id);
    // Clear leftovers from last time. A killed process leaves its socket file
    // behind, which then causes EADDRINUSE.
    await fs.promises.rm(this.socketPath, { force: true });

    // CDP events out to clients. Without this channel goto() and every waitFor*
    // time out; see CdpDriver.onCdpEvent.
    this.unsubscribeCdpEvents =
      this.opts.driver.onCdpEvent?.((evt) => this.broadcastCdpEvent(evt)) ?? null;
    this.unsubscribeDownloadChanges =
      this.opts.driver.onDownloadChange?.((change) => this.broadcastDownloadChange(change)) ?? null;

    const server = net.createServer((socket) => {
      // Code-signature peer verification. Off by default and enforced only in
      // signed release builds; see peer-auth.ts.
      if (!authorizePeer(socket)) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      const entry: { peer: JsonRpcPeer; sessionId?: string } = {
        peer: new JsonRpcPeer(
          socket,
          // Record each request's session_id: delivering events by lease needs to
          // know who this connection is.
          this.trackingHandlers(() => entry),
          () => {
            /* An error on one connection must not take the backend down. */
          },
        ),
      };
      this.peers.set(socket, entry);
      socket.once("close", () => {
        this.sockets.delete(socket);
        this.peers.delete(socket);
        // One kernel can leave several connections behind after a repeated setup;
        // only the last one closing releases anything.
        if (entry.sessionId != null) this.releaseDisconnectedSession(entry.sessionId);
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await fs.promises.chmod(this.socketPath, 0o600);
    return this.socketPath;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    // Destroy live connections first, or server.close() waits forever on the
    // long-lived ones clients hold.
    this.unsubscribeCdpEvents?.();
    this.unsubscribeCdpEvents = null;
    this.unsubscribeDownloadChanges?.();
    this.unsubscribeDownloadChanges = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.peers.clear();
    this.targetSessionsByTabId.clear();
    this.targetBySessionId.clear();
    this.cachedCdpExpressions.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // The socket file does not remove itself, and leaving it lets discovery find
    // a dead backend nothing can connect to.
    if (this.socketPath) await fs.promises.rm(this.socketPath, { force: true });
  }
}

const CAPTURE_SURFACE_WAIT_MS = 1_000;
const CAPTURE_SURFACE_POLL_MS = 16;

/**
 * A temporary capture surface is only needed for a screenshot that reaches beyond
 * the viewport and carries a valid clip size.
 */
function captureSurfaceSize(method: string, params: unknown): CaptureSurfaceSize | null {
  if (method !== "Page.captureScreenshot" || !isRecord(params)) return null;
  if (params.captureBeyondViewport !== true || !isRecord(params.clip)) return null;
  const width = params.clip.width;
  const height = params.clip.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

async function executeCdpCommandWithCaptureSurface(
  driver: CdpDriver,
  tabId: number,
  method: string,
  params: unknown,
  sessionId?: string,
): Promise<unknown> {
  const surface = captureSurfaceSize(method, params);
  const setCaptureSurface = driver.setCaptureSurface?.bind(driver);
  if (surface == null || setCaptureSurface == null) {
    return await driver.sendCommand(tabId, method, params, sessionId);
  }

  await setCaptureSurface(tabId, surface);
  try {
    await waitForCaptureSurface(driver, tabId, surface);
    return await driver.sendCommand(tabId, method, params, sessionId);
  } finally {
    // The surface must be torn down even when the screenshot failed, and a failure
    // to tear down must not mask the original CDP result or error.
    await setCaptureSurface(tabId, null).catch(() => {});
  }
}

/**
 * Wait for the capture surface: up to one second, reading cssVisualViewport every
 * 16ms. On a failed read or a timeout, let the screenshot proceed anyway so
 * Chromium returns the real CDP error.
 */
async function waitForCaptureSurface(
  driver: CdpDriver,
  tabId: number,
  expected: CaptureSurfaceSize,
): Promise<void> {
  const deadline = Date.now() + CAPTURE_SURFACE_WAIT_MS;
  do {
    let metrics: unknown;
    try {
      metrics = await withTimeout(
        driver.sendCommand(tabId, "Page.getLayoutMetrics", {}),
        Math.max(1, deadline - Date.now()),
        `Timed out reading layout metrics for tab ${tabId}`,
      );
    } catch {
      return;
    }
    if (captureSurfaceIsReady(metrics, expected)) return;
    await delay(CAPTURE_SURFACE_POLL_MS);
  } while (Date.now() < deadline);
}

function captureSurfaceIsReady(metrics: unknown, expected: CaptureSurfaceSize): boolean {
  if (!isRecord(metrics)) return false;
  const viewport = isRecord(metrics.cssVisualViewport)
    ? metrics.cssVisualViewport
    : isRecord(metrics.visualViewport)
      ? metrics.visualViewport
      : null;
  if (viewport == null) return false;
  return (
    numericDimension(viewport, "clientWidth", "width") >= expected.width &&
    numericDimension(viewport, "clientHeight", "height") >= expected.height
  );
}

function numericDimension(
  value: Record<string, unknown>,
  preferred: string,
  fallback: string,
): number {
  const first = value[preferred];
  if (typeof first === "number") return first;
  const second = value[fallback];
  return typeof second === "number" ? second : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function reqNonEmptyString(p: unknown, key: string, method: string): string {
  const value = isRecord(p) ? p[key] : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${method} requires a non-empty ${key}`);
  }
  return value;
}

function reqOptionalString(p: unknown, key: string): string | undefined {
  const value = isRecord(p) ? p[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cdpResultValue(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.result)) return undefined;
  return value.result.value;
}

async function waitForDocumentReady(
  driver: CdpDriver,
  tabId: number,
  timeoutMs: number,
): Promise<{ href?: string; title?: string }> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const evaluated = await withTimeout(
        driver.sendCommand(tabId, "Runtime.evaluate", {
          expression:
            "({ href: window.location.href, title: document.title, readyState: document.readyState })",
          returnByValue: true,
        }),
        Math.max(1, deadline - Date.now()),
        `Timed out reading temporary tab ${tabId}`,
      );
      const state = cdpResultValue(evaluated);
      if (isRecord(state)) {
        const readyState = state.readyState;
        if (readyState === "interactive" || readyState === "complete") {
          return {
            ...(typeof state.href === "string" ? { href: state.href } : {}),
            ...(typeof state.title === "string" ? { title: state.title } : {}),
          };
        }
      }
    } catch {
      // A fresh renderer can reject Runtime.evaluate briefly while navigating.
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for temporary tab ${tabId} to load`);
}

function tabsContentExpression(contentType: "html" | "text" | "domSnapshot"): string {
  if (contentType === "html") {
    return "document.documentElement?.outerHTML ?? ''";
  }
  if (contentType === "text") {
    return "document.body?.innerText ?? ''";
  }
  return `(() => {
    const cloneWithFrames = (doc) => {
      const clone = doc.documentElement.cloneNode(true);
      const sourceFrames = [...doc.querySelectorAll("iframe,frame")];
      const clonedFrames = [...clone.querySelectorAll("iframe,frame")];
      sourceFrames.forEach((frame, index) => {
        try {
          const child = frame.contentDocument;
          if (child?.documentElement && clonedFrames[index]) {
            clonedFrames[index].setAttribute(
              "data-operon-frame-content",
              child.documentElement.outerHTML
            );
          }
        } catch {}
      });
      return "<!doctype html>\\n" + clone.outerHTML;
    };
    return cloneWithFrames(document);
  })()`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Read and validate a tabId from the wire, returning a number: tabId is always
 * numeric at the wire layer (see BrowserUseTab.id). A numeric string such as
 * `"5"` is tolerated, because some client paths send one, but it must convert to
 * a positive integer.
 */
function reqTabId(p: unknown): number {
  const raw = (p as { tabId?: unknown } | undefined)?.tabId;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new Error("requires an integer tabId");
  return n;
}

/**
 * Read this request's session_id. Every session method requires it.
 */
function reqSession(p: unknown): string {
  const sid = (p as { session_id?: unknown } | undefined)?.session_id;
  if (typeof sid !== "string") throw new Error("Missing required browser session_id");
  return sid;
}

/**
 * Turn `finalizeTabs`' `keep` into a Map of tabId to status. Intersecting it with
 * the session's current tabs happens in the caller, against the lease ledger.
 */
function parseKeep(keep: unknown[]): Map<number, TabStatus | undefined> {
  const out = new Map<number, TabStatus | undefined>();
  const toId = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  for (const item of keep) {
    if (typeof item === "string" || typeof item === "number") {
      const id = toId(item);
      if (id != null) out.set(id, undefined);
      continue;
    }
    const o = item as { tabId?: unknown; tab_id?: unknown; status?: unknown };
    const id = toId(o?.tabId ?? o?.tab_id);
    if (id == null) continue;
    const status = o?.status === "handoff" || o?.status === "deliverable" ? o.status : undefined;
    out.set(id, status);
  }
  return out;
}
