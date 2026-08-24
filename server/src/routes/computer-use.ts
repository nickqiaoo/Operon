/**
 * Computer Use settings: a single master switch.
 *
 * This is shorter than browser-use.ts because Browser Use keeps its own record
 * of approvals (TOML under `~/.operon/browser/`, written by the browser client),
 * so that route also manages origin approvals and full CDP. Computer Use decides
 * per-app approval through `computer.get_app_policy` and a node_repl
 * elicitation, answered by the user in the conversation and never written to a
 * store we can read or edit. There is nothing to manage, only the switch.
 */

import { Hono } from 'hono'
import { createRuntimeLogger } from '@operon/agent-runtime'
import { getComputerUseConfig, updateComputerUseConfig } from '../services/computer-use-config.js'
import { syncComputerUseSkill } from '../services/computer-use-skill.js'
import {
  disposeAllNodeReplSessions,
  getComputerUsePermissions,
  openComputerUsePermissionSettings,
} from './node-repl-mcp.js'

const logger = createRuntimeLogger('computer-use')

export function computerUseRoutes() {
  const router = new Hono()

  router.get('/settings', (c) => c.json({ enabled: getComputerUseConfig().enabled }))

  /**
   * macOS permission state. This has to be asked of the engine process: TCC
   * grants against that binary, not against Electron, so a preflight run by the
   * host answers for a different identity than the one that actually captures.
   *
   * It exists because of a real failure: once Screen Recording was revoked, model
   * screenshots and PiP both vanished silently, with nowhere in the app to see why.
   */
  router.get('/permissions', async (c) => {
    if (!getComputerUseConfig().enabled) {
      return c.json({ enabled: false, running: false, accessibility: false, screenRecording: false })
    }
    try {
      return c.json({ enabled: true, ...(await getComputerUsePermissions()) })
    } catch (e) {
      logger.warn(`failed to read computer use permissions: ${e}`)
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  router.post('/permissions/open', async (c) => {
    const { permission } = await c.req.json<{ permission?: string }>()
    if (permission !== 'accessibility' && permission !== 'screenRecording') {
      return c.json({ error: 'permission must be accessibility or screenRecording' }, 400)
    }
    try {
      await openComputerUsePermissionSettings(permission)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  /**
   * The switch. Three things, mirroring browser-use's `/enabled`:
   *
   *  - The skill is a file on disk that agents find by scanning directories, so
   *    it has to be installed or deleted right here.
   *  - The MCP needs nothing: node_repl is shared by both features and mounted
   *    on an OR in `mcp-config.ts`, so it is already there if Browser Use is on.
   *  - Kernels for running sessions are long-lived and had
   *    `SKY_CUA_NATIVE_PIPE_PATH` baked into their env at fork time, which the
   *    switch cannot reach. They are torn down and rebuilt, and the shared Swift
   *    engine stops with them.
   */
  router.post('/enabled', async (c) => {
    const { enabled } = await c.req.json<{ enabled?: boolean }>()
    if (typeof enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400)
    try {
      await syncComputerUseSkill(enabled)
      updateComputerUseConfig({ enabled })
      // Turning it *on* also has to clear them: an old kernel has no socket path
      // in its env, so without a rebuild `computer.*` still cannot connect.
      await disposeAllNodeReplSessions()
      logger.info(`computer use ${enabled ? 'enabled' : 'disabled'}`)
      return c.json({ ok: true })
    } catch (e) {
      // If installing or deleting the skill fails, leave the flag alone. A switch
      // that looks like it did nothing beats a flag claiming on while the agent
      // cannot see the skill.
      logger.error(`failed to ${enabled ? 'enable' : 'disable'} computer use: ${e}`)
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  return router
}
