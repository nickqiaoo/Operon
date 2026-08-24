/**
 * Browser Use settings: reads and writes the browser approvals an agent remembers.
 *
 * The store is the same one `nodeRepl.config` persists to
 * (`createTomlConfigStore` in `@operon/computer-use`), rooted at `~/.operon/`:
 *
 *   ~/.operon/browser/config.toml           ->  full_cdp_access_enabled = true
 *   ~/.operon/browser/sessions/<id>.toml    ->  [origins] allowed = ["https://…"]
 *
 * The browser client computes these paths and hands them to the host: global
 * scope is `browser/config.toml`, a single session is
 * `browser/sessions/<conversationId>.toml`. This route has to read the same
 * relative paths rather than invent its own.
 */

import { Hono } from 'hono'
import { createTomlConfigStore } from '@operon/computer-use'
import { createRuntimeLogger } from '@operon/agent-runtime'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getBrowserUseConfig, updateBrowserUseConfig } from '../services/browser-use-config.js'
import { syncBrowserUseSkill } from '../services/browser-use-skill.js'
import { disposeAllNodeReplSessions } from './node-repl-mcp.js'

const logger = createRuntimeLogger('browser-use')

/** Same root as the store node-repl-mcp.ts hands the kernel: both default to `~/.operon`. */
const store = createTomlConfigStore()
const ROOT = path.join(os.homedir(), '.operon')
const GLOBAL_TOML = 'browser/config.toml'
const SESSIONS_DIR = 'browser/sessions'

/** The key names the browser client's schema uses. */
const FULL_CDP_KEY = 'full_cdp_access_enabled'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v)

/** Pull `[origins] allowed = [...]` out of a parsed toml object. */
function readOrigins(doc: unknown, key: 'allowed' | 'denied'): string[] {
  if (!isRecord(doc)) return []
  const origins = doc.origins
  if (!isRecord(origins)) return []
  const list = origins[key]
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
}

export interface BrowserApprovals {
  /** Origins the user explicitly allowed for every conversation. The only set
   *  worth listing. */
  allowed: string[]
  denied: string[]
  /**
   * How many approvals past conversations remember. A count, with no detail.
   *
   * Detail would not help: these are bound to a single session
   * (`browser/sessions/<conversationId>.toml`) and stop meaning anything once it
   * ends. Telling someone "session 019f5a22 allowed example.com" gives them
   * nothing to act on, because they cannot tell which conversation that was. So
   * this exposes a total and a single button to clear it.
   */
  rememberedFromConversations: number
  fullCdpAccess: boolean
  configPath: string
  /** Master switch. Off means neither the skill nor the node_repl MCP is
   *  injected, and the agent cannot see a browser at all. */
  enabled: boolean
}

/** List the files under sessions/ that actually carry an approval; empty ones do not count. */
async function sessionFilesWithApprovals(): Promise<string[]> {
  let files: string[] = []
  try {
    files = await fs.promises.readdir(path.join(ROOT, SESSIONS_DIR))
  } catch {
    return [] // No directory means nothing has ever been approved.
  }
  const out: string[] = []
  for (const f of files) {
    if (!f.endsWith('.toml')) continue
    const doc = await store.readToml(`${SESSIONS_DIR}/${f}`)
    if (readOrigins(doc, 'allowed').length || readOrigins(doc, 'denied').length) out.push(f)
  }
  return out
}

export function browserUseRoutes() {
  const router = new Hono()

  /**
   * The Browser Use master switch.
   *
   * The two injection paths have different lifetimes, so this does three things
   * rather than just setting a flag:
   *
   *  - The skill is a file on disk (`~/.agents/skills`, `~/.grok/skills`,
   *    `~/.claude/skills`) that agents discover by scanning those directories.
   *    "Stop installing it from now on" changes nothing for copies already
   *    written, so it has to be installed or deleted right here.
   *  - The MCP entry is computed per session by `buildMcpServersForCli`, so the
   *    switch takes effect on its own for the next new session.
   *  - Sessions already running had their mcpServers baked at creation and the
   *    switch cannot reach them, so every long-lived kernel child process is
   *    torn down instead. Their node_repl dies immediately, and the route
   *    refuses reconnects.
   */
  router.post('/enabled', async (c) => {
    const { enabled } = await c.req.json<{ enabled?: boolean }>()
    if (typeof enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400)
    try {
      await syncBrowserUseSkill(enabled)
      updateBrowserUseConfig({ enabled })
      if (!enabled) await disposeAllNodeReplSessions()
      logger.info(`browser use ${enabled ? 'enabled' : 'disabled'}`)
      return c.json({ ok: true })
    } catch (e) {
      // If installing or deleting the skill fails, leave the flag alone. A switch
      // that looks like it did nothing beats a flag claiming on while the agent
      // cannot see the skill.
      logger.error(`failed to ${enabled ? 'enable' : 'disable'} browser use: ${e}`)
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  /** Global approvals, plus a count of the ones past sessions remember. */
  router.get('/approvals', async (c) => {
    try {
      const globalDoc = await store.readToml(GLOBAL_TOML)
      const remembered = await sessionFilesWithApprovals()
      const body: BrowserApprovals = {
        allowed: readOrigins(globalDoc, 'allowed'),
        denied: readOrigins(globalDoc, 'denied'),
        rememberedFromConversations: remembered.length,
        fullCdpAccess: isRecord(globalDoc) && globalDoc[FULL_CDP_KEY] === true,
        configPath: path.join(ROOT, 'browser'),
        enabled: getBrowserUseConfig().enabled,
      }
      return c.json(body)
    } catch (e) {
      logger.error(`failed to read browser approvals: ${e}`)
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  /** Revoke one globally approved origin. The next visit asks again. */
  router.post('/approvals/revoke', async (c) => {
    const { origin } = await c.req.json<{ origin?: string }>()
    if (!origin) return c.json({ error: 'origin is required' }, 400)
    try {
      const rel = GLOBAL_TOML
      const doc = await store.readToml(rel)
      const base = isRecord(doc) ? { ...doc } : {}
      const origins = isRecord(base.origins) ? { ...base.origins } : {}
      for (const key of ['allowed', 'denied'] as const) {
        const list = origins[key]
        if (Array.isArray(list)) origins[key] = list.filter((x) => x !== origin)
      }
      base.origins = origins
      await store.writeToml(rel, base)
      logger.info(`revoked global browser origin ${origin}`)
      return c.json({ ok: true })
    } catch (e) {
      logger.error(`failed to revoke browser origin: ${e}`)
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  /**
   * Clear every approval past conversations remember, leaving global ones alone.
   *
   * The files are deleted outright rather than having `[origins]` emptied: these
   * toml files exist only to record approvals, so an empty shell means nothing.
   * The writer recreates them on demand anyway (`writeToml` does mkdir -p).
   */
  router.post('/approvals/clear', async (c) => {
    try {
      const files = await sessionFilesWithApprovals()
      for (const f of files) {
        await fs.promises.rm(path.join(ROOT, SESSIONS_DIR, f), { force: true })
      }
      logger.info(`cleared browser approvals remembered from ${files.length} conversation(s)`)
      return c.json({ ok: true, cleared: files.length })
    } catch (e) {
      logger.error(`failed to clear browser approvals: ${e}`)
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  /**
   * Full CDP access lets an agent send arbitrary raw CDP commands rather than
   * only the high-level actions the SDK wraps. That is a lot of reach, so it
   * gets its own switch and defaults to off.
   */
  router.post('/full-cdp-access', async (c) => {
    const { enabled } = await c.req.json<{ enabled?: boolean }>()
    try {
      const doc = await store.readToml(GLOBAL_TOML)
      const base = isRecord(doc) ? { ...doc } : {}
      if (enabled === true) base[FULL_CDP_KEY] = true
      else delete base[FULL_CDP_KEY]
      await store.writeToml(GLOBAL_TOML, base)
      logger.info(`full CDP access ${enabled ? 'enabled' : 'disabled'}`)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  return router
}
