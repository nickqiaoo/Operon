/**
 * Reader for the privileged page bridge the Operon browser runtime installs on
 * the kernel realm (see packages/browser-use/sdk/adapter-bridge.ts).
 *
 * Deliberately not re-exported from the package index: the bridge is for the
 * commands shipped here, not for model code that imports this package.
 */

import type { SiteBrowserTab } from "../types.ts"

export const SITE_ADAPTER_BRIDGE_KEY = Symbol.for("operon.browser-use.site-adapter-bridge")

export interface BridgeCookie {
  name: string
  value: string
  domain: string
  path: string
  httpOnly?: boolean
  secure?: boolean
  expires?: number
}

export interface SiteAdapterBridge {
  evaluate<T = unknown>(
    tab: SiteBrowserTab,
    expression: string,
    options?: { timeoutMs?: number },
  ): Promise<T | undefined>
  addInitScript(tab: SiteBrowserTab, source: string): Promise<string>
  removeInitScript(tab: SiteBrowserTab, id: string): Promise<void>
  getCookies(tab: SiteBrowserTab, urls: string[]): Promise<BridgeCookie[]>
}

export function siteAdapterBridge(): SiteAdapterBridge | null {
  const value = (globalThis as unknown as Record<symbol, unknown>)[SITE_ADAPTER_BRIDGE_KEY]
  if (value == null || typeof value !== "object") return null
  const bridge = value as Partial<SiteAdapterBridge>
  if (typeof bridge.evaluate !== "function" || typeof bridge.addInitScript !== "function") return null
  return bridge as SiteAdapterBridge
}
