import { resolveArgs } from "./runtime/args.ts"
import { openPage } from "./runtime/page.ts"
import { executePipeline } from "./runtime/pipeline.ts"

import {
  commandId,
  registerCommand,
  type CommandRunner,
} from "./registry.ts"
import type { AdapterPage, CommandContext, CommandDefinition, InvokeOptions, SiteBrowser } from "./types.ts"

function needsBrowser(def: CommandDefinition): boolean {
  if (def.browser === false) return false
  if (def.browser === true) return true
  if (def.strategy === "public") return false
  return true
}

/**
 * Define + register a site command (pipeline and/or func).
 *   await siteAdapters.bilibili.hot({ limit: 10, browser: chrome })
 *
 * Browser commands get a tab up front. Commands with `browser: false` never
 * open one on their own; a func that can fall back to the browser asks for a
 * tab through `ctx.openPage()`, which works only when the caller passed one.
 */
export function defineCommand(def: CommandDefinition): CommandRunner {
  const id = commandId(def.site, def.name)
  const browserRequired = needsBrowser(def)

  const runner = (async (options: InvokeOptions = {}) => {
    const { browser, ...rest } = options
    const args = resolveArgs(def.args, rest, id)
    const hasBrowser = browser != null && typeof (browser as SiteBrowser).tabs?.new === "function"

    let page: AdapterPage | null = null
    const ctx: CommandContext = {
      hasBrowser,
      async openPage() {
        if (page) return page
        if (!hasBrowser) {
          throw new Error(`${id}: this needs a browser session (pass browser: globalThis.chrome)`)
        }
        page = await openPage(browser as SiteBrowser)
        return page
      },
    }
    try {
      if (browserRequired) {
        if (!hasBrowser) {
          throw new Error(
            `${id}: options.browser is required (pass globalThis.chrome from the agent sandbox)`,
          )
        }
        await ctx.openPage()
      }

      if (typeof def.func === "function") {
        return await def.func(page, args, ctx)
      }

      if (!def.pipeline) {
        throw new Error(`${id}: command has neither pipeline nor func`)
      }
      return await executePipeline(page, def.pipeline, args)
    } finally {
      await (page as AdapterPage | null)?.close()
    }
  }) as CommandRunner

  runner.definition = def
  return registerCommand(runner)
}
