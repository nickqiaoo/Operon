/**
 * Thin page surface over Operon Chrome / Browser Use tabs.
 * Enough for OpenCLI-style cookie pipelines + func adapters.
 */

import type { AdapterPage, SiteBrowser, SiteBrowserTab } from "../types.ts"
import { siteAdapterBridge } from "./bridge.ts"
import { READ_INTERCEPTED_SOURCE, interceptorSource } from "./interceptor.ts"

export type { AdapterPage }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Adapters navigate to app-shell sites (x.com, youtube.com, bilibili.com) whose
 * first paint routinely lands past the client's 10s default. A timeout here
 * aborts the whole command, so buy more room.
 */
const NAVIGATION_TIMEOUT_MS = 30_000

/**
 * Turn a source into something `Runtime.evaluate` runs: a bare function (arrow
 * or `function`) is invoked, anything else is an expression. The read-only
 * client path does the same on its side; the bridge takes raw expressions.
 */
export function toEvaluateExpression(source: string): string {
  const code = source.trim()
  if (!code) return "undefined"
  if (/^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/u.test(code)) return `(${code})()`
  if (/^(?:async\s+)?function[\s(]/u.test(code)) return `(${code})()`
  return code
}

/** OpenCLI `page.wait(3)` means 3 seconds; values >= 100 are milliseconds. */
function waitMs(value: number | { time: number }): number {
  const n = typeof value === "number" ? value : Number(value?.time ?? 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 100 ? n * 1000 : n
}

export async function openPage(browser: SiteBrowser): Promise<AdapterPage> {
  let tab: SiteBrowserTab = await browser.tabs.new()
  let interceptorScriptId: string | null = null

  const requireBridge = (what: string) => {
    const bridge = siteAdapterBridge()
    if (!bridge) {
      throw new Error(
        `${what} needs the Operon browser runtime's site-adapter bridge; connect with setupBrowserRuntime() first`,
      )
    }
    return bridge
  }

  const page: AdapterPage = {
    async goto(url: string) {
      await tab.goto(url, { timeoutMs: NAVIGATION_TIMEOUT_MS })
    },
    async evaluate(source: string) {
      return tab.playwright.evaluate(source)
    },
    async evaluateWrite(source: string, options?: { timeoutMs?: number }) {
      return requireBridge("evaluateWrite").evaluate(tab, toEvaluateExpression(source), options)
    },
    async cookieHeader(url: string) {
      const cookies = await requireBridge("cookieHeader").getCookies(tab, [url])
      return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
    },
    async fetchJson(url, options = {}) {
      const method = options.method ?? "GET"
      const headers = options.headers ?? {}
      const source = `(async () => {
  const res = await fetch(${JSON.stringify(url)}, {
    method: ${JSON.stringify(method)},
    headers: ${JSON.stringify(headers)},
    credentials: "include",
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText + " from " + ${JSON.stringify(url)});
  return res.json();
})()`
      return tab.playwright.evaluate(source)
    },
    async wait(value) {
      await sleep(waitMs(value))
    },
    async autoScroll(options = {}) {
      const times = Math.max(1, Math.floor(options.times ?? 3))
      const delayMs = Math.max(0, Math.floor(options.delayMs ?? 2000))
      for (let i = 0; i < times; i++) {
        // Synchronous and read-only: window.scrollTo is not a DOM write.
        await tab.playwright.evaluate(`(() => {
  const el = document.scrollingElement || document.documentElement || document.body;
  window.scrollTo(0, Math.max(el ? el.scrollHeight : 0, document.body ? document.body.scrollHeight : 0));
  return true;
})()`)
        await sleep(delayMs)
      }
    },
    async installInterceptor(pattern: string) {
      const bridge = requireBridge("installInterceptor")
      const source = interceptorSource(pattern)
      if (interceptorScriptId != null) {
        await bridge.removeInitScript(tab, interceptorScriptId).catch(() => {})
      }
      interceptorScriptId = await bridge.addInitScript(tab, `(${source})()`)
      // Also patch the current document, for callers that install after goto.
      await bridge.evaluate(tab, `(${source})()`)
    },
    async getInterceptedRequests() {
      const bridge = siteAdapterBridge()
      const result = bridge
        ? await bridge.evaluate(tab, READ_INTERCEPTED_SOURCE)
        : await tab.playwright.evaluate(READ_INTERCEPTED_SOURCE)
      return Array.isArray(result) ? result : []
    },
    async url() {
      const fromTab = await tab.url?.()
      if (typeof fromTab === "string") return fromTab
      const fromPage = await tab.playwright.evaluate<string>("location.href")
      return typeof fromPage === "string" ? fromPage : ""
    },
    async replaceTab(url: string) {
      const previous = tab
      const fresh = await browser.tabs.new()
      await fresh.goto(url, { timeoutMs: NAVIGATION_TIMEOUT_MS })
      tab = fresh
      interceptorScriptId = null
      await previous.close?.().catch(() => {})
    },
    async close() {
      // Ephemeral tabs are cleaned up by the browser session turn.
    },
  }
  return page
}

export async function hostFetchJson(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<unknown> {
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.headers,
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`)
  }
  return res.json()
}
