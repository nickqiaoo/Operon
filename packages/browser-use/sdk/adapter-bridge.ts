/**
 * The privileged page channel for built-in site adapters.
 *
 * `tab.playwright.evaluate` is read-only on purpose: model code must not click,
 * POST or patch `fetch` from inside a page script, it has to go through locators
 * and the approval gates. Site adapters are different. They are shipped with
 * the app, run in the kernel realm, and drive sites whose own UI and signed
 * requests only work from inside the page (Xiaohongshu publish, follow, the
 * 点点 conversation store, response interception).
 *
 * So they get this bridge, and model code does not. It is installed on the
 * kernel realm's `globalThis` under a registered symbol, the same realm that
 * holds the full `nodeRepl` with `nativePipe`. Model code runs in a vm sandbox
 * with its own `globalThis` and never sees it. Do not re-export it from
 * `runtime.ts`: an export is exactly the way around the gate this avoids.
 */

import { cdp, evaluateOrThrow } from "./internals.ts";
import { recordTabMutation } from "./response-meta.ts";

export const SITE_ADAPTER_BRIDGE_KEY = Symbol.for("operon.browser-use.site-adapter-bridge");

export interface SiteAdapterBridge {
  /**
   * `Runtime.evaluate` in the page's main world, without the read-only guard.
   * Awaits a returned promise; `timeoutMs` (default 3 minutes) bounds it so a
   * script waiting on a page that never settles cannot hang the turn.
   */
  evaluate<T = unknown>(tab: object, expression: string, options?: { timeoutMs?: number }): Promise<T | undefined>;
  /** Run `source` in every new document of this tab, before page scripts. Returns an id for removal. */
  addInitScript(tab: object, source: string): Promise<string>;
  removeInitScript(tab: object, id: string): Promise<void>;
  /** Cookies the browser would send to `urls`, httpOnly ones included. */
  getCookies(tab: object, urls: string[]): Promise<BridgeCookie[]>;
}

export interface BridgeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  expires?: number;
}

const DEFAULT_EVALUATE_TIMEOUT_MS = 180_000;

const bridge: SiteAdapterBridge = Object.freeze({
  async evaluate<T = unknown>(
    tab: object,
    expression: string,
    options: { timeoutMs?: number } = {},
  ): Promise<T | undefined> {
    if (typeof expression !== "string" || expression.length === 0) {
      throw new Error("site adapter evaluate requires an expression");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`site adapter page script timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    let value: T | undefined;
    try {
      value = await Promise.race([evaluateOrThrow<T>(tab, expression), timeout]);
    } finally {
      clearTimeout(timer);
    }
    // A script that can click and submit counts as a page mutation for the
    // turn's tab bookkeeping, the same as a locator action.
    recordTabMutation(tab);
    return value;
  },
  async addInitScript(tab: object, source: string): Promise<string> {
    if (typeof source !== "string" || source.length === 0) {
      throw new Error("site adapter addInitScript requires source");
    }
    await cdp(tab, "Page.enable");
    const result = await cdp<{ identifier?: string }>(
      tab,
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
    );
    if (typeof result?.identifier !== "string") {
      throw new Error("Page.addScriptToEvaluateOnNewDocument returned no identifier");
    }
    return result.identifier;
  },
  async removeInitScript(tab: object, id: string): Promise<void> {
    await cdp(tab, "Page.removeScriptToEvaluateOnNewDocument", { identifier: id });
  },
  async getCookies(tab: object, urls: string[]): Promise<BridgeCookie[]> {
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error("site adapter getCookies requires at least one url");
    }
    const result = await cdp<{ cookies?: BridgeCookie[] }>(tab, "Network.getCookies", { urls });
    return Array.isArray(result?.cookies) ? result.cookies : [];
  },
});

/** Idempotent: the kernel imports the client once per process, but be safe. */
export function installSiteAdapterBridge(): void {
  const realm = globalThis as unknown as Record<symbol, unknown>;
  if (realm[SITE_ADAPTER_BRIDGE_KEY] != null) return;
  Object.defineProperty(realm, SITE_ADAPTER_BRIDGE_KEY, {
    value: bridge,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
