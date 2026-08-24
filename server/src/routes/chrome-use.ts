/**
 * Chrome Browser Use settings: one master switch plus installation state.
 *
 * Same shape as browser-use and computer-use, with one addition: a native host.
 * That is not an extra security mechanism, it is the pipe this path runs
 * through. Without it Chrome is simply unreachable: Chrome never spawns the
 * host, no socket appears under `/tmp/operon-browser-use/`, and
 * `browsers.get("chrome")` finds no backend. Hanging it off the same switch also
 * means turning the feature off leaves no registration behind in the user's
 * Chrome profile that could launch operon.
 *
 * The real capability gate is still the MCP: with node_repl unmounted there is
 * no `js` tool, the model cannot execute JavaScript at all, and so cannot
 * bootstrap a browser client (see the OR in mcp-config.ts). The skill only
 * decides whether it is told about any of this.
 */

import { Hono } from 'hono'
import { createRuntimeLogger } from '@operon/agent-runtime'
import {
  CHROME_EXTENSION_IDS,
  CHROME_STORE_EXTENSION_ID,
  chromeNativeHostStatus,
  detectChromeExtension,
  installChromeNativeHost,
  uninstallChromeNativeHost,
} from '@operon/browser-use'
import { getChromeUseConfig, updateChromeUseConfig } from '../services/chrome-use-config.js'
import { syncChromeUseSkill } from '../services/chrome-use-skill.js'
import { syncSiteAdaptersSkill } from '../services/site-adapters-skill.js'
import { disposeAllNodeReplSessions } from './node-repl-mcp.js'

const logger = createRuntimeLogger('chrome-use')

export function chromeUseRoutes() {
  const router = new Hono()

  /**
   * Switch state plus what is actually installed.
   *
   * Installation state is read straight from Chrome's own profile registry
   * rather than inferred by trying to connect. "Not installed" and "installed
   * but the host is broken" call for completely different advice, and a failed
   * connection cannot tell them apart.
   */
  router.get('/settings', async (c) => {
    // Scan both the unpacked dev id and the Web Store id so either install path works.
    const detection = detectChromeExtension({ extensionIds: CHROME_EXTENSION_IDS })
    const host = await chromeNativeHostStatus()
    return c.json({
      enabled: getChromeUseConfig().enabled,
      extensionId: detection.matchedExtensionId ?? CHROME_STORE_EXTENSION_ID,
      chromeInstalled: detection.browserInstalled,
      extensionInstalled: detection.installed,
      extensionDisabled: detection.disabled,
      profiles: detection.profiles,
      nativeHostInstalled: host.installed,
      // The host manifest survives but the binary it execs is gone, typically
      // because an upgrade moved the path. Chrome reports only a generic
      // connection failure, so say it plainly here instead.
      nativeHostStale: host.installed && !host.execPathExists,
    })
  })

  /**
   * The switch. Three things happen:
   *
   *  - The skill is a file on disk that agents find by scanning directories, so
   *    it has to be installed or deleted right here. "Stop installing it from
   *    now on" changes nothing for copies already written.
   *  - The native host is a manifest plus wrapper inside Chrome's config
   *    directory: installed when on, removed cleanly when off.
   *  - The MCP needs nothing here. node_repl is shared by three features and
   *    mounted on an OR in `mcp-config.ts`.
   *
   * Kernels for sessions already running are long-lived, which is exactly how
   * `agent.browsers` survives across turns, and their mcpServers were computed
   * at creation. The switch cannot reach back to them, so they are all torn
   * down and rebuilt.
   */
  router.post('/enabled', async (c) => {
    const { enabled } = await c.req.json<{ enabled?: boolean }>()
    if (typeof enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400)
    try {
      await syncChromeUseSkill(enabled)
      // Site-adapter index skill depends on Chrome session; keep it in lockstep.
      await syncSiteAdaptersSkill(enabled)
      if (enabled) await installChromeNativeHost()
      else await uninstallChromeNativeHost()
      updateChromeUseConfig({ enabled })
      await disposeAllNodeReplSessions()
      logger.info(`chrome use ${enabled ? 'enabled' : 'disabled'}`)
      return c.json({ ok: true })
    } catch (e) {
      // If installing or removing the skill or the host fails, leave the flag
      // alone. A switch that looks like it did nothing beats a flag claiming on
      // while the agent has no skill, or the path does not work at all.
      logger.error(`failed to ${enabled ? 'enable' : 'disable'} chrome use: ${e}`)
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  /**
   * Reinstall the native host.
   *
   * This exists because of upgrades: the wrapper execs an absolute, versioned
   * path, so an app upgrade leaves it pointing at a file that no longer exists,
   * and Chrome reports only a generic connection failure. With the switch
   * already on there would otherwise be no repair short of toggling it off and
   * on again, so this makes the repair explicit.
   */
  router.post('/reinstall-host', async (c) => {
    try {
      const result = await installChromeNativeHost()
      logger.info(`chrome native host reinstalled: ${result.manifestPaths.length} manifest(s)`)
      return c.json({ ok: true, manifestPaths: result.manifestPaths })
    } catch (e) {
      logger.error(`failed to reinstall chrome native host: ${e}`)
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  return router
}
