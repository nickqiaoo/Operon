/**
 * Minimal duck types for the browser client + command definitions.
 * Keep this loose: adapters only need tabs + evaluate, not the full surface.
 */

export interface SiteBrowserTab {
  goto(url: string): Promise<void>
  playwright: {
    /**
     * Page-context evaluate. Accepts a function body or an async IIFE string.
     * Closures do not work — any args must be inlined into the source.
     */
    evaluate<T = unknown>(pageFunction: string | ((...args: never[]) => unknown)): Promise<T>
  }
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
  evaluate(source: string): Promise<unknown>
  fetchJson(
    url: string,
    options?: { method?: string; headers?: Record<string, string> },
  ): Promise<unknown>
  /** OpenCLI often uses seconds; values >= 100 are treated as milliseconds. */
  wait(secondsOrMs: number): Promise<void>
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

/** Imperative command with page + args (OpenCLI `func` adapters). */
export interface FuncCommandDefinition extends CommandMeta {
  pipeline?: never
  /** `page` is null for public browser:false commands. */
  func: (page: AdapterPage | null, args: Record<string, unknown>) => Promise<unknown>
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
