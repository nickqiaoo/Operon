import { resolveArgs } from "./runtime/args.ts"
import { openPage } from "./runtime/page.ts"
import { executePipeline } from "./runtime/pipeline.ts"

import {
  commandId,
  registerCommand,
  type CommandRunner,
} from "./registry.ts"
import type { CommandDefinition, InvokeOptions, SiteBrowser } from "./types.ts"

function needsBrowser(def: CommandDefinition): boolean {
  if (def.browser === false) return false
  if (def.browser === true) return true
  if (def.strategy === "public") return false
  return true
}

/**
 * Define + register a site command (pipeline and/or func).
 *   await siteAdapters.bilibili.hot({ limit: 10, browser: chrome })
 */
export function defineCommand(def: CommandDefinition): CommandRunner {
  const id = commandId(def.site, def.name)
  const browserRequired = needsBrowser(def)

  const runner = (async (options: InvokeOptions = {}) => {
    const { browser, ...rest } = options
    const args = resolveArgs(def.args, rest, id)

    let page: Awaited<ReturnType<typeof openPage>> | null = null
    try {
      if (browserRequired) {
        if (browser == null || typeof (browser as SiteBrowser).tabs?.new !== "function") {
          throw new Error(
            `${id}: options.browser is required (pass globalThis.chrome from the agent sandbox)`,
          )
        }
        page = await openPage(browser as SiteBrowser)
      } else if (browser != null && typeof (browser as SiteBrowser).tabs?.new === "function") {
        page = await openPage(browser as SiteBrowser)
      }

      if (typeof def.func === "function") {
        if (browserRequired && page == null) {
          throw new Error(`${id}: browser page is required`)
        }
        return await def.func(page, args)
      }

      if (!def.pipeline) {
        throw new Error(`${id}: command has neither pipeline nor func`)
      }
      return await executePipeline(page, def.pipeline, args)
    } finally {
      await page?.close()
    }
  }) as CommandRunner

  runner.definition = def
  return registerCommand(runner)
}
