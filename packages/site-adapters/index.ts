/**
 * @operon/site-adapters
 *
 * Deterministic site commands for Operon agents (OpenCLI-style web adapters).
 * Import from node_repl via `nodeRepl.env.OPERON_SITE_ADAPTERS_PATH`.
 *
 * Always pass `browser: globalThis.chrome` for cookie/UI commands — adapters run
 * in the trusted import realm and do not share the agent sandbox's globalThis.
 */

/** Env key injected into node_repl so skills never hard-code app install paths. */
export const OPERON_SITE_ADAPTERS_PATH_ENV = "OPERON_SITE_ADAPTERS_PATH"

export { list, search, help, run, getCommand, commandId } from "./registry.ts"
export { defineCommand } from "./define.ts"
export type {
  AccessMode,
  ArgDef,
  BilibiliHotOptions,
  CommandDefinition,
  CommandInfo,
  HotVideo,
  InvokeOptions,
  PipelineStep,
  SiteBrowser,
  SiteBrowserTab,
  Strategy,
} from "./types.ts"

// Side-effect: register all commands when the package is imported.
export * as bilibili from "./bilibili/index.ts"
export * as zhihu from "./zhihu/index.ts"
export * as hackernews from "./hackernews/index.ts"
export * as v2ex from "./v2ex/index.ts"
export * as reddit from "./reddit/index.ts"
export * as twitter from "./twitter/index.ts"
export * as github from "./github/index.ts"
export * as youtube from "./youtube/index.ts"
export * as wikipedia from "./wikipedia/index.ts"
export * as arxiv from "./arxiv/index.ts"
export * as stackoverflow from "./stackoverflow/index.ts"
export * as bluesky from "./bluesky/index.ts"
export * as producthunt from "./producthunt/index.ts"
