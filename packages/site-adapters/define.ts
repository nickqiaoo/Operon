import { ArgumentError, CommandExecutionError, SiteAdapterError, errorMessage } from "./errors.ts"
import {
  commandId,
  registerCommand,
  type CommandRunner,
} from "./registry.ts"
import { resolveArgs } from "./runtime/args.ts"
import { openPage } from "./runtime/page.ts"
import type { AdapterPage, CommandContext, CommandDefinition, InvokeOptions, SiteBrowser } from "./types.ts"

/**
 * Define and register a site function.
 *   await siteAdapters.bilibili.hot({ limit: 10, browser: chrome })
 *
 * Browser commands get a tab up front. Commands with `browser: false` never
 * open one on their own; a func that can fall back to the browser asks for a
 * tab through `ctx.openPage()`, which works only when the caller passed one.
 */
export function defineCommand<Result>(def: CommandDefinition<Result>): CommandRunner<Result> {
  const id = commandId(def.site, def.name)
  const browserRequired = def.browser

  const runner = (async (options: InvokeOptions = {}): Promise<Result> => {
    const { browser, ...rest } = options
    const args = resolveArgs(def.args, rest, id)
    const hasBrowser = browser != null && typeof (browser as SiteBrowser).tabs?.new === "function"

    let page: AdapterPage | null = null
    const ctx: CommandContext = {
      hasBrowser,
      async openPage() {
        if (page) return page
        if (!hasBrowser) {
          throw new ArgumentError(`${id}: this needs a browser session (pass browser: globalThis.chrome)`)
        }
        page = await openPage(browser as SiteBrowser)
        return page
      },
    }
    try {
      if (browserRequired) {
        if (!hasBrowser) {
          throw new ArgumentError(
            `${id}: options.browser is required (pass globalThis.chrome from the agent sandbox)`,
          )
        }
        await ctx.openPage()
      }

      return await def.func(page, args, ctx)
    } catch (error) {
      if (error instanceof SiteAdapterError) throw error
      throw new CommandExecutionError(errorMessage(error))
    } finally {
      await (page as AdapterPage | null)?.close()
    }
  }) as CommandRunner<Result>

  runner.definition = def
  return registerCommand(runner)
}
