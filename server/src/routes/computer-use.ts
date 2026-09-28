/**
 * Computer Use settings: the master switch, macOS grants, and app approvals.
 *
 * App approvals are decided in the conversation (a node_repl elicitation the
 * host approval broker answers) and remembered in `computer-use-config`: apps
 * and cross-app capabilities approved with "Always allow", plus apps the user
 * blocked here. This route lets Settings show and edit that record. The
 * protected list is built into the engine and only shown, never edited.
 */

import { Hono } from 'hono'
import { createRuntimeLogger } from '@operon/agent-runtime'
import { COMPUTER_USE_PROTECTED_BUNDLE_IDS } from '@operon/computer-use'
import {
  COMPUTER_USE_CAPABILITIES,
  getComputerUseConfig,
  isComputerUseCapability,
  setComputerUseAppRule,
  setComputerUseCapabilityApproved,
  updateComputerUseConfig,
} from '../services/computer-use-config.js'
import { syncComputerUseSkill } from '../services/computer-use-skill.js'
import {
  clearSessionComputerUseApprovals,
  countSessionComputerUseApprovals,
} from '../services/ai/host-approval-broker.js'
import {
  disposeAllNodeReplSessions,
  getComputerUsePermissions,
  listComputerUseApps,
  openComputerUsePermissionSettings,
} from './node-repl-mcp.js'

const logger = createRuntimeLogger('computer-use')

export function computerUseRoutes() {
  const router = new Hono()

  router.get('/settings', (c) => {
    return c.json({ enabled: getComputerUseConfig().enabled })
  })

  /**
   * macOS permission state, as the engine process sees it. The embedded daemon
   * runs on the app's grants, but it caches them per process, so its answer is
   * the one that says whether capture works right now (a stale one is fixed by
   * a restart in getComputerUsePermissions).
   *
   * It exists because of a real failure: once Screen Recording was revoked,
   * model screenshots vanished silently, with nowhere in the app to see why.
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
   * Everything that decides which apps an agent may operate without asking.
   * Names come from the engine's app listing when it is running; a bundle id it
   * does not know (uninstalled since) is shown as is.
   */
  router.get('/approvals', async (c) => {
    const config = getComputerUseConfig()
    const installed = config.enabled ? await listComputerUseApps() : []
    const names = new Map(installed.map((app) => [app.bundleId.toLowerCase(), app.name]))
    const describe = (bundleId: string) => ({ bundleId, name: names.get(bundleId.toLowerCase()) ?? null })
    return c.json({
      approvedApps: config.approvedApps.map(describe),
      blockedApps: config.blockedApps.map(describe),
      protectedApps: [...COMPUTER_USE_PROTECTED_BUNDLE_IDS].sort().map(describe),
      capabilities: COMPUTER_USE_CAPABILITIES.map((id) => ({
        id,
        approved: config.approvedCapabilities.includes(id),
      })),
      conversationsWithApprovals: countSessionComputerUseApprovals(),
    })
  })

  /** Installed and running apps for the picker; empty while the engine is off. */
  router.get('/apps', async (c) => {
    return c.json({ apps: await listComputerUseApps() })
  })

  /** `rule: null` removes the app from both lists. */
  router.post('/approvals/app', async (c) => {
    const { app, rule } = await c.req.json<{ app?: unknown; rule?: unknown }>()
    if (typeof app !== 'string' || app.trim() === '') return c.json({ error: 'app must be a bundle identifier' }, 400)
    if (rule !== 'allow' && rule !== 'block' && rule !== null) {
      return c.json({ error: 'rule must be allow, block or null' }, 400)
    }
    if (rule === 'allow' && COMPUTER_USE_PROTECTED_BUNDLE_IDS.has(app.trim().toLowerCase())) {
      return c.json({ error: 'This app is protected and cannot be allowed' }, 400)
    }
    setComputerUseAppRule(app, rule)
    return c.json({ ok: true })
  })

  router.post('/approvals/capability', async (c) => {
    const { capability, approved } = await c.req.json<{ capability?: unknown; approved?: unknown }>()
    if (!isComputerUseCapability(capability)) return c.json({ error: 'unknown capability' }, 400)
    if (typeof approved !== 'boolean') return c.json({ error: 'approved must be a boolean' }, 400)
    setComputerUseCapabilityApproved(capability, approved)
    return c.json({ ok: true })
  })

  /** Forget "allow for this conversation" approvals in every open conversation. */
  router.post('/approvals/clear-conversations', (c) => {
    clearSessionComputerUseApprovals()
    return c.json({ ok: true })
  })

  /**
   * The switch. Three things, mirroring browser-use's `/enabled`:
   *
   *  - The skill is a file on disk that agents find by scanning directories, so
   *    it has to be installed or deleted right here.
   *  - The MCP needs nothing: node_repl is shared by both features and mounted
   *    on an OR in `mcp-config.ts`, so it is already there if Browser Use is on.
   *  - Kernels for running sessions are long-lived and had the daemon socket
   *    baked into their env at fork time, which the switch cannot reach. They
   *    are torn down and rebuilt, and the shared cua-driver daemon stops with
   *    them.
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
