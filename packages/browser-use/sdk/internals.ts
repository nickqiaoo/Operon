/**
 * The internal half of operon's browser SDK: everything the model must not see.
 *
 * ## Why it exists
 *
 * The objects handed to a model expose only what the documentation promises:
 *
 * ```
 * Browser own: [browserId, capabilities, tabs, user]   proto: [documentation, nameSession]
 * Tab     own: [id, playwright, dom_cua, cua, content, clipboard, dev, capabilities]
 *         proto: [goto, markHandoff, markDeliverable, back, forward, reload, close,
 *                 screenshot, title, url, getJsDialog, …]
 * ```
 *
 * No internal fields at all. Our first version put `conn`, the raw transport,
 * and a dozen pieces of internal state and internal methods directly on the
 * instances. An agent then ran
 * `Object.getOwnPropertyNames(Object.getPrototypeOf(tab))`, found our internal
 * `evaluateOrThrow` and started calling it as API, bypassing every check we had
 * and breaking the moment we renamed it.
 *
 * TypeScript's `private` is compile-time only: at runtime it is an ordinary
 * property and `getOwnPropertyNames` still sees it. There are exactly three ways
 * to hide something for real: a `#` private field, a closure, or the WeakMap
 * this file uses.
 *
 * ## Why a WeakMap rather than `#` fields
 *
 * Things like `cdp` and `injectPlaywright` have to be reachable across modules
 * while staying invisible to the model: both `playwright.ts` and `cua.ts` call
 * them, and a `#` private method cannot leave its class. So state goes into a
 * WeakMap and the methods become module-level functions. They sit on no
 * prototype, so nothing can enumerate them, while an `import` in the same package
 * reaches them directly.
 *
 * This file must not import `index.ts` or `playwright.ts`. That would be a
 * cycle, and a const referenced across a cycle is `undefined` at module
 * evaluation time. It has happened: a constant inside `FRAME_PRELUDE`
 * interpolated to the literal string "undefined", and iframes ended up tagged
 * with an attribute actually named "undefined". The dependency direction has to
 * stay one-way: internals <- playwright/cua <- index.
 */
import { createHash } from "node:crypto";
import type { BackendConnection, CdpEventNotification, DownloadChange } from "./transport.ts";
import { loadPlaywrightInjectedSource } from "./playwright-injected-source.ts";
import { recordTabMutation } from "./response-meta.ts";

// -------------------------------- Constants --------------------------------

/** Global name the injected instance is attached to on the page. */
export const INJECTED_CONSTANT = "__codexPlaywrightInjected";

/**
 * A cross-origin iframe is unreachable from inside the page: its
 * `contentDocument` is null. So it gets tagged with an attribute, found again
 * from the CDP side with `DOM.querySelector`, and resolved through
 * `DOM.describeNode` to a frameId, which is the OOPIF's targetId.
 */
export const OOPIF_MARKER_ATTR = "data-operon-oopif";

/** Options used when constructing an InjectedScript inside a frame. They must
 *  match the main frame's. */
export const INJECTED_OPTIONS = {
  isUnderTest: false,
  sdkLanguage: "javascript",
  testIdAttributeName: "data-testid",
  stableRafCount: 1,
  browserName: "chromium",
  customEngines: [] as unknown[],
};

// ─────────────────────────── Playwright blob ───────────────────────────

/**
 * Playwright's injectedScript: 191KB of Apache-2.0 code, used as-is.
 *
 * `lib/generated/` is not in playwright-core's `exports` map, so the only way in
 * is to resolve its `package.json` and build the internal path by hand. That
 * depends on internal layout, which is why `playwright-core` is a direct
 * dependency of this package and pinned to an exact version.
 * `../playwright-injected.test.ts` guards it.
 */
let cachedExpression: string | undefined;
/** The injection expression. It passes `window` rather than globalThis, and omits
 *  `isUtilityWorld`. */
export function playwrightInjectExpression(): string {
  if (cachedExpression != null) return cachedExpression;
  cachedExpression = `(() => {
  if (!window.${INJECTED_CONSTANT}) {
    const module = {};
    ${loadPlaywrightInjectedSource()}
    window.${INJECTED_CONSTANT} = new (module.exports.InjectedScript())(window, ${JSON.stringify(INJECTED_OPTIONS)});
  }
})()`;
  return cachedExpression;
}

/** Cache key: `playwright-injected:` followed by the base64url sha256 of the source. */
function playwrightCacheKey(expression: string): string {
  return `playwright-injected:${createHash("sha256").update(expression).digest("base64url")}`;
}

// ------------------- core: internal state, held in a WeakMap -------------------

/**
 * All of a Tab's internal state.
 *
 * Only Tab needs a WeakMap, because `playwright.ts` and `cua.ts` read it across
 * module boundaries. `Browser`, `Tabs` and `Locator` have no such need and use
 * `#` private fields, which are equally private at runtime without the extra
 * indirection. Do not move them here for the sake of uniformity.
 */
export interface TabCore {
  conn: BackendConnection;
  id: number;
  playwrightInjected: boolean;
  fetchUnsubscribe?: () => void;
  dialogUnsubscribe?: () => void;
  activeDialog?: {
    type: string;
    message: string;
    defaultPrompt?: string;
  };
  consoleUnsubscribe?: () => void;
  consoleLogs: Array<{
    level: "debug" | "info" | "log" | "warn" | "error";
    message: string;
    timestamp: string;
    url?: string;
  }>;
  clipboardGranted: boolean;
  /** OOPIF targets Playwright has already been injected into. Injection is
   *  per-process and cannot be reused across targets. */
  injectedTargets: Set<string>;
}

/** A WeakMap leaves no property on the object, so neither `Object.keys` nor
 *  `getOwnPropertyNames` can see any of this. */
const tabCores = new WeakMap<object, TabCore>();

export function attachTabCore(tab: object, core: TabCore): void {
  tabCores.set(tab, core);
}
export function tabCore(tab: object): TabCore {
  const c = tabCores.get(tab);
  if (c == null) throw new Error("Tab is not initialised (internal)");
  return c;
}

/** Cached injection-expression keys, reused across tabs; the backend's cache is
 *  global too. */
const sentCachedExpressions = new Set<string>();

// ---------------------- Module-level internal methods ----------------------
//
// These are on no prototype, so a model cannot enumerate them, while an import
// inside this package reaches them directly.

/**
 * `executeCdp`: `{target:{tabId}, method, commandParams}` plus the session
 * triple. `targetId` is for cross-origin OOPIFs, which the backend resolves into
 * a flattened debugger sessionId.
 */
export async function cdp<T = unknown>(
  tab: object,
  method: string,
  commandParams: Record<string, unknown> = {},
  targetId?: string,
): Promise<T> {
  const core = tabCore(tab);
  const result = await core.conn.sendSessionRequest<T>("executeCdp", {
    target: targetId == null ? { tabId: core.id } : { tabId: core.id, targetId },
    method,
    commandParams,
  });
  if (
    method.startsWith("Input.")
    || method === "DOM.setFileInputFiles"
    || method === "Page.handleJavaScriptDialog"
    || method === "Page.navigate"
    || method === "Page.navigateToHistoryEntry"
    || method === "Page.reload"
  ) {
    recordTabMutation(tab);
  }
  return result;
}

/** `Runtime.evaluate`, re-throwing page-side exceptions. Without checking
 *  `exceptionDetails` they are swallowed silently. */
export async function evaluateOrThrow<T = unknown>(tab: object, expression: string, targetId?: string): Promise<T | undefined> {
  const r = await cdp<{
    result?: { value?: T };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  }>(tab, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, targetId);
  const ex = r?.exceptionDetails;
  if (ex != null) throw new Error(ex.exception?.description ?? ex.text ?? "page evaluation failed");
  return r?.result?.value;
}

export function sessionRequest<T = unknown>(tab: object, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const core = tabCore(tab);
  return core.conn.sendSessionRequest<T>(method, { tabId: core.id, ...params });
}

export function onTabCdpEvent(tab: object, cb: (e: CdpEventNotification) => void): () => void {
  const core = tabCore(tab);
  return core.conn.onCdpEvent((event) => {
    if (event.source.tabId !== core.id) return;
    cb(event);
  });
}
export function onTabDownloadChange(tab: object, cb: (c: DownloadChange) => void): () => void {
  return tabCore(tab).conn.onDownloadChange(cb);
}

/** Current href/readiness probe used internally by navigation and wait state machines. */
export async function tabLocation(tab: object): Promise<{ href?: string; readyState?: string }> {
  const result = await cdp<{
    result?: { value?: { href?: string; readyState?: string } };
  }>(
    tab,
    "Runtime.evaluate",
    {
      expression: "({ href: window.location.href, readyState: document.readyState })",
      returnByValue: true,
    },
  );
  return result?.result?.value ?? {};
}

export async function waitForTabLoadState(
  tab: object,
  state: "load" | "domcontentloaded" = "load",
  timeoutMs = 30_000,
): Promise<void> {
  const ready = async (): Promise<boolean> => {
    const location = await tabLocation(tab);
    return location.readyState === "complete"
      || (state === "domcontentloaded" && location.readyState === "interactive");
  };
  if (await ready()) return;

  await new Promise<void>((resolve, reject) => {
    const method = state === "load" ? "Page.loadEventFired" : "Page.domContentEventFired";
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for load state "${state}"`));
    }, timeoutMs);
    const off = onTabCdpEvent(tab, (event) => {
      if (event.method !== method) return;
      clearTimeout(timer);
      off();
      resolve();
    });
    void ready().then((isReady) => {
      if (!isReady) return;
      clearTimeout(timer);
      off();
      resolve();
    }, () => {
      // The event listener remains authoritative when the second readiness probe fails.
    });
  });
}

/** Attach to an OOPIF target; the backend remembers the targetId to sessionId
 *  mapping. */
export function attachTarget(tab: object, targetId: string, parentTargetId?: string): Promise<void> {
  return sessionRequest<void>(tab, "attachTarget", {
    targetId,
    ...(parentTargetId == null ? {} : { parentTargetId }),
  });
}

/**
 * Resolve a tagged iframe element to its CDP targetId. In CDP an OOPIF's
 * `targetId` is its `frameId`, and `DOM.describeNode` returns `frameId` for a
 * frame owner element.
 */
export async function oopifTargetIdForMarker(
  tab: object,
  marker: string,
  parentTargetId?: string,
): Promise<string | undefined> {
  const doc = await cdp<{ root?: { nodeId?: number } }>(
    tab,
    "DOM.getDocument",
    { depth: -1, pierce: true },
    parentTargetId,
  );
  const rootId = doc?.root?.nodeId;
  if (rootId == null) return undefined;
  let nodeId = (
    await cdp<{ nodeId?: number }>(
      tab,
      "DOM.querySelector",
      { nodeId: rootId, selector: `[${OOPIF_MARKER_ATTR}="${marker}"]` },
      parentTargetId,
    )
  )?.nodeId;
  if (nodeId == null || nodeId === 0) {
    const search = await cdp<{ searchId?: string; resultCount?: number }>(
      tab,
      "DOM.performSearch",
      {
        query: `[${OOPIF_MARKER_ATTR}="${marker}"]`,
        includeUserAgentShadowDOM: true,
      },
      parentTargetId,
    );
    if (search.searchId != null && (search.resultCount ?? 0) > 0) {
      try {
        const result = await cdp<{ nodeIds?: number[] }>(
          tab,
          "DOM.getSearchResults",
          { searchId: search.searchId, fromIndex: 0, toIndex: 1 },
          parentTargetId,
        );
        nodeId = result.nodeIds?.[0];
      } finally {
        await cdp(
          tab,
          "DOM.discardSearchResults",
          { searchId: search.searchId },
          parentTargetId,
        ).catch(() => {});
      }
    }
  }
  if (nodeId == null || nodeId === 0) return undefined;
  const described = await cdp<{ node?: { frameId?: string } }>(
    tab,
    "DOM.describeNode",
    { nodeId },
    parentTargetId,
  );
  return described?.node?.frameId;
}

/**
 * Push Playwright's injectedScript into the page.
 *
 * It goes through `executeCdpWithCachedExpression`, so the 191KB is sent once and
 * later calls hit the backend's cache by key. From the second call on the
 * `expression` has to be deleted from the payload, or every locator call ships
 * 191KB again.
 */
export async function injectPlaywright(tab: object): Promise<void> {
  const core = tabCore(tab);
  if (core.playwrightInjected) return;
  const expression = playwrightInjectExpression();
  const expressionCacheKey = playwrightCacheKey(expression);
  const commandParams: Record<string, unknown> = { awaitPromise: true, returnByValue: true };
  if (!sentCachedExpressions.has(expressionCacheKey)) commandParams.expression = expression;

  const result = await core.conn.sendSessionRequest<{ kind?: string }>("executeCdpWithCachedExpression", {
    target: { tabId: core.id },
    method: "Runtime.evaluate",
    commandParams,
    expressionCacheKey,
  });
  // The backend did not have it cached, after a restart or a different backend.
  // Retry with the full source.
  if (result?.kind === "cache-miss") {
    sentCachedExpressions.delete(expressionCacheKey);
    await core.conn.sendSessionRequest("executeCdpWithCachedExpression", {
      target: { tabId: core.id },
      method: "Runtime.evaluate",
      commandParams: { awaitPromise: true, returnByValue: true, expression },
      expressionCacheKey,
    });
  }
  sentCachedExpressions.add(expressionCacheKey);
  core.playwrightInjected = true;
}

/**
 * Forget that this tab was injected, so the next injection really runs.
 *
 * The injected helper lives on `window`, so a navigation takes it with it. Both caches that
 * record "already injected" then describe a page that no longer exists: `playwrightInjected`
 * for the main frame and `injectedTargets` for OOPIFs and execution contexts. Clearing only
 * one leaves the other short-circuiting, which is how the frame path keeps failing while the
 * main one recovers.
 *
 * Call this where a navigation completes, not where a call fails. Recovering on failure means
 * reinjecting inside a retry loop that runs every RETRY_INTERVAL_MS, which pins the browser at
 * 100% CPU sending the 191KB payload over and over.
 */
export function forgetPlaywrightInjection(tab: object): void {
  const core = tabCore(tab);
  core.playwrightInjected = false;
  core.injectedTargets.clear();
}

/** Inject into one OOPIF target. Injection does not cross processes, so each
 *  target needs its own. */
export async function injectPlaywrightInTarget(
  tab: object,
  targetId: string | undefined,
  executionContextId?: number,
): Promise<void> {
  const core = tabCore(tab);
  const cacheKey = `${targetId ?? "root"}:${executionContextId ?? "default"}`;
  if (core.injectedTargets.has(cacheKey)) return;
  await cdp(tab, "Runtime.enable", {}, targetId);
  await cdp(
    tab,
    "Target.setAutoAttach",
    {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
      filter: [{ type: "iframe", exclude: false }],
    },
    targetId,
  ).catch(() => {
    // A local frame execution context is not a Target domain endpoint.
  });
  await cdp(
    tab,
    "Runtime.evaluate",
    {
      expression: playwrightInjectExpression(),
      awaitPromise: true,
      returnByValue: true,
      ...(executionContextId == null ? {} : { contextId: executionContextId }),
    },
    targetId,
  );
  core.injectedTargets.add(cacheKey);
}
