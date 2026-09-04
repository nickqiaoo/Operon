/**
 * Thin page surface over Operon Chrome / Browser Use tabs.
 * Enough for OpenCLI-style cookie pipelines + func adapters.
 */

import type { AdapterPage, SiteBrowser, SiteBrowserTab } from "../types.ts"

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

export async function openPage(browser: SiteBrowser): Promise<AdapterPage> {
  const tab: SiteBrowserTab = await browser.tabs.new()
  return {
    async goto(url: string) {
      await tab.goto(url, { timeoutMs: NAVIGATION_TIMEOUT_MS })
    },
    async evaluate(source: string) {
      return tab.playwright.evaluate(source)
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
    async wait(secondsOrMs: number) {
      // OpenCLI `page.wait(3)` means 3 seconds; values >= 100 treated as ms.
      const ms = secondsOrMs > 0 && secondsOrMs < 100 ? secondsOrMs * 1000 : secondsOrMs
      await sleep(ms)
    },
    async close() {
      // Ephemeral tabs are cleaned up by the browser session turn.
    },
  }
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
