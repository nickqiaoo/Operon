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
  ChromeAccessDeniedError,
  chromeNativeHostStatus,
  detectChromeExtension,
  installChromeNativeHost,
  readChromePresence,
  uninstallChromeNativeHost,
} from '@operon/browser-use'
import { getChromeUseConfig, updateChromeUseConfig } from '../services/chrome-use-config.js'
import { syncChromeUseSkill } from '../services/chrome-use-skill.js'
import { syncSiteAdaptersSkill } from '../services/site-adapters-skill.js'
import { disposeAllNodeReplSessions } from './node-repl-mcp.js'

const logger = createRuntimeLogger('chrome-use')

/**
 * Report a denial as a plain sentence rather than a 500 with a stack.
 *
 * Not reachable on a stock macOS + Chrome — `NativeMessagingHosts/` is exempt
 * from the protection on the rest of the profile directory — so this is a
 * fallback for the Chromium forks we also install into. It deliberately offers
 * no remedy: the only one would be Full Disk Access, which this feature has no
 * business asking for.
 */
function accessDeniedResponse(e: unknown) {
  if (!(e instanceof ChromeAccessDeniedError)) return null
  return { error: e.message, code: e.code, deniedPath: e.deniedPath }
}

export function chromeUseRoutes() {
  const router = new Hono()

  /**
   * Switch state plus what is actually installed.
   *
   * Two sources, and the order matters. Presence is observed from the running
   * system — Chrome only spawns our native host when the extension connects, so
   * a live host proves installed *and* enabled *and* reachable in one shot, and
   * costs no privacy grant. The profile registry is the fallback: it answers
   * when Chrome is closed, but it sits behind Full Disk Access and so is
   * frequently unreadable. Neither alone covers the ground; presence is the one
   * that is trusted when both have an opinion.
   */
  router.get('/settings', async (c) => {
    // Scan both the unpacked dev id and the Web Store id so either install path works.
    const detection = detectChromeExtension({ extensionIds: CHROME_EXTENSION_IDS })
    const host = await chromeNativeHostStatus()
    const presence = await readChromePresence()
    return c.json({
      enabled: getChromeUseConfig().enabled,
      // A connected extension reports the id it is actually running under, which
      // beats both the registry guess and the hardcoded fallback.
      extensionId:
        presence.extensions[0]?.extensionId ??
        detection.matchedExtensionId ??
        CHROME_STORE_EXTENSION_ID,
      chromeInstalled: detection.browserInstalled,
      // A live connection settles it regardless of whether the registry could be read.
      extensionInstalled: presence.connected || detection.installed,
      extensionDisabled: detection.disabled,
      profiles: detection.profiles,
      /** The extension answered just now. */
      extensionConnected: presence.connected,
      /** Epoch ms of the last connection; null means it has never reached us. */
      extensionLastSeenAt: presence.lastSeenAt,
      nativeHostInstalled: host.installed,
      // The host manifest survives but the binary it execs is gone, typically
      // because an upgrade moved the path. Chrome reports only a generic
      // connection failure, so say it plainly here instead.
      nativeHostStale: host.installed && !host.execPathExists,
      // The registry was unreadable *and* nothing has ever connected, so the
      // extension's state is genuinely unknown rather than known-absent. A past
      // connection answers the question on its own, which is why presence is
      // checked first here: it makes the missing grant irrelevant in the common
      // case, and the UI asks the user for nothing either way.
      extensionUnknown:
        detection.permissionDenied && !presence.connected && presence.lastSeenAt == null,
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
      const denied = accessDeniedResponse(e)
      if (denied) return c.json(denied, 403)
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
      const denied = accessDeniedResponse(e)
      if (denied) return c.json(denied, 403)
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  return router
}
