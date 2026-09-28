/**
 * Minimal duck types for the browser client + command definitions.
 * Keep this loose: adapters only need tabs + evaluate, not the full surface.
 */

export interface SiteBrowserTab {
  goto(url: string, options?: { timeoutMs?: number }): Promise<void>
  playwright: {
    /**
     * Page-context evaluate. Accepts a function body or an async IIFE string.
     * Closures do not work — any args must be inlined into the source.
     */
    evaluate<T = unknown>(pageFunction: string | ((...args: never[]) => unknown)): Promise<T>
  }
  url?(): Promise<string | undefined>
  close?(): Promise<void>
}

export interface SiteBrowser {
  tabs: {
    /**
     * The quotes are load-bearing. Written bare as `new(): T`, TypeScript reads
     * it as a construct signature rather than a method called `new`. The name
     * itself mirrors the browser API this wraps (`browser.tabs.new()`).
     */
    "new"(): Promise<SiteBrowserTab>
  }
}

/** Page surface handed to `func` adapters (OpenCLI `page`). */
export interface AdapterPage {
  goto(url: string): Promise<void>
  /** Read-only: the browser client rejects clicks, POSTs and DOM writes here. */
  evaluate(source: string): Promise<unknown>
  /**
   * Unguarded main-world evaluate for scripts that click, type, submit or call
   * a site's own (signed) request stack. Built-in adapters only; needs the
   * privileged bridge the Operon browser runtime installs in the kernel realm.
   */
  evaluateWrite(source: string, options?: { timeoutMs?: number }): Promise<unknown>
  /** Cookies for `url`'s host, httpOnly included, as a `Cookie` header value. Privileged. */
  cookieHeader(url: string): Promise<string>
  fetchJson(
    url: string,
    options?: { method?: string; headers?: Record<string, string> },
  ): Promise<unknown>
  /** OpenCLI often uses seconds; values >= 100 are treated as milliseconds. */
  wait(secondsOrMs: number | { time: number }): Promise<void>
  /**
   * Scroll to the bottom `times` times, pausing `delayMs` for lazy loads. The
   * pause happens on the host, between evaluations, because a read-only script
   * that awaits inside the page blocks the page's own DOM inserts meanwhile.
   */
  autoScroll(options?: { times?: number; delayMs?: number }): Promise<void>
  /**
   * Capture JSON responses whose URL contains `pattern`. Survives navigation,
   * so install before `goto` to catch the first-screen requests.
   */
  installInterceptor(pattern: string): Promise<void>
  /** Captured payloads since the last read (the buffer is cleared). */
  getInterceptedRequests(): Promise<unknown[]>
  url(): Promise<string>
  /** Swap the command's tab for a fresh one at `url`, closing the old one. */
  replaceTab(url: string): Promise<void>
  close(): Promise<void>
}

export type AccessMode = "read" | "write"
export type Strategy = "public" | "cookie" | "ui" | "intercept"

export interface ArgDef {
  name: string
  type?: "string" | "int" | "bool"
  required?: boolean
  /** Positional in CLI help; ignored for JS call style. */
  positional?: boolean
  default?: unknown
  help?: string
  choices?: string[]
}

export type PipelineStep =
  | { navigate: string | { url: string } }
  | { evaluate: string }
  | { fetch: string | { url: string; method?: string; params?: Record<string, unknown>; headers?: Record<string, unknown> } }
  | { map: Record<string, unknown> }
  | { filter: string }
  | { limit: unknown }
  | { sort: string | { by: string; order?: "asc" | "desc" } }
  | { select: string }

export interface CommandMeta {
  site: string
  name: string
  description: string
  access?: AccessMode
  domain?: string
  strategy?: Strategy
  /**
   * When false, runs without a browser tab (host-side fetch).
   * Default true for cookie/ui; false is typical for public JSON APIs.
   */
  browser?: boolean
  args?: ArgDef[]
  columns?: string[]
  /**
   * Extra search terms for `search()`, beyond the id and description.
   *
   * These adapters cover sites whose own vocabulary is not English, and whose
   * users search in that vocabulary. Descriptions stay English so the command
   * list reads consistently; the native term goes here so "热门" still finds
   * the hot-feed commands.
   */
  keywords?: string[]
}

/** Declarative OpenCLI-style pipeline command. */
export interface PipelineCommandDefinition extends CommandMeta {
  pipeline: PipelineStep[]
  func?: never
}

/** What a func gets besides its page and args. */
export interface CommandContext {
  /** Whether the caller passed a browser. */
  hasBrowser: boolean
  /**
   * The command's tab, opened on first call. For `browser: false` commands
   * that fall back to the browser only when the direct route fails.
   */
  openPage(): Promise<AdapterPage>
}

/** Imperative command with page + args (OpenCLI `func` adapters). */
export interface FuncCommandDefinition extends CommandMeta {
  pipeline?: never
  /** `page` is null for browser:false commands; they can use `ctx.openPage()`. */
  func: (page: AdapterPage | null, args: Record<string, unknown>, ctx: CommandContext) => Promise<unknown>
}

export type CommandDefinition = PipelineCommandDefinition | FuncCommandDefinition

export interface InvokeOptions {
  /** Required when the command needs a browser session. */
  browser?: SiteBrowser
  [key: string]: unknown
}

export interface CommandInfo {
  id: string
  site: string
  name: string
  description: string
  access: AccessMode
  domain?: string
  strategy: Strategy
  browser: boolean
  args: ArgDef[]
  columns: string[]
  keywords: string[]
}

export interface HotVideo {
  rank: number
  title: string
  author: string
  play: number
  danmaku: number
  bvid: string
  url: string
}

export interface BilibiliHotOptions {
  limit?: number
  browser: SiteBrowser
}
