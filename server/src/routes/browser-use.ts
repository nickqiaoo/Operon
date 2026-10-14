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
const RESOURCE_KEYS = ['origins', 'downloads', 'uploads'] as const
type BrowserResource = typeof RESOURCE_KEYS[number]
const MODE_KEYS = {
  origins: 'approval_mode',
  downloads: 'download_approval_mode',
  uploads: 'upload_approval_mode',
  history: 'history_approval_mode',
} as const
type BrowserMode = keyof typeof MODE_KEYS

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v)

/** Pull `[origins] allowed = [...]` out of a parsed toml object. */
function readOrigins(doc: unknown, key: 'allowed' | 'denied'): string[] {
  return readResource(doc, 'origins', key)
}

function readResource(doc: unknown, resource: BrowserResource, key: 'allowed' | 'denied'): string[] {
  if (!isRecord(doc) || !isRecord(doc[resource])) return []
  const list = doc[resource][key]
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
}

/**
 * What an unset mode means — must match DEFAULT_APPROVAL_MODES in
 * packages/browser-use/sdk/security.ts. Opening a site is reading, so it goes
 * ahead; file transfers and history ask.
 */
const DEFAULT_MODES: Record<BrowserMode, 'ask' | 'never_ask'> = {
  origins: 'never_ask',
  downloads: 'ask',
  uploads: 'ask',
  history: 'ask',
}

function readMode(doc: unknown, resource: BrowserMode): 'ask' | 'never_ask' {
  const value = isRecord(doc) ? doc[MODE_KEYS[resource]] : undefined
  return value === 'ask' || value === 'never_ask' ? value : DEFAULT_MODES[resource]
}

export interface BrowserApprovals {
  /** Origins the user explicitly allowed for every conversation. The only set
   *  worth listing. */
  allowed: string[]
  denied: string[]
  downloads: { allowed: string[]; denied: string[] }
  uploads: { allowed: string[]; denied: string[] }
  modes: Record<BrowserMode, 'ask' | 'never_ask'>
  /**
   * How many conversation files contain site, upload, or download decisions.
   *
   * Detail would not help: these are bound to a single session
   * (`browser/sessions/<conversationId>.toml`). Telling someone
   * "session 019f5a22 allowed example.com" gives them
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

function isBrowserResource(value: unknown): value is BrowserResource {
  return RESOURCE_KEYS.some((key) => key === value)
}

function isBrowserMode(value: unknown): value is BrowserMode {
  return typeof value === 'string' && Object.hasOwn(MODE_KEYS, value)
}

function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

function globalDocument(doc: unknown): Record<string, unknown> {
  return isRecord(doc) ? { ...doc } : {}
}

function resourceTable(doc: Record<string, unknown>, resource: BrowserResource): Record<string, unknown> {
  return isRecord(doc[resource]) ? { ...doc[resource] } : {}
}

/** Count conversation files with saved site or file-transfer decisions. */
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
    if (RESOURCE_KEYS.some((resource) =>
      readResource(doc, resource, 'allowed').length || readResource(doc, resource, 'denied').length
    )) out.push(f)
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
        downloads: {
          allowed: readResource(globalDoc, 'downloads', 'allowed'),
          denied: readResource(globalDoc, 'downloads', 'denied'),
        },
        uploads: {
          allowed: readResource(globalDoc, 'uploads', 'allowed'),
          denied: readResource(globalDoc, 'uploads', 'denied'),
        },
        modes: {
          origins: readMode(globalDoc, 'origins'),
          downloads: readMode(globalDoc, 'downloads'),
          uploads: readMode(globalDoc, 'uploads'),
          history: readMode(globalDoc, 'history'),
        },
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

  /** Edit the same global resource tables that Browser Use reads for both backends. */
  router.post('/approvals/rule', async (c) => {
    const { resource, origin, decision } = await c.req.json<{
      resource?: unknown; origin?: unknown; decision?: unknown
    }>()
    const normalized = normalizeOrigin(origin)
    if (!isBrowserResource(resource) || normalized == null || (decision !== 'allow' && decision !== 'deny')) {
      return c.json({ error: 'A resource, HTTP(S) URL, and allow or deny decision are required' }, 400)
    }
    try {
      const doc = globalDocument(await store.readToml(GLOBAL_TOML))
      const table = resourceTable(doc, resource)
      const chosen = decision === 'allow' ? 'allowed' : 'denied'
      const opposite = decision === 'allow' ? 'denied' : 'allowed'
      table[chosen] = [...new Set([...readResource(doc, resource, chosen), normalized])]
      table[opposite] = readResource(doc, resource, opposite).filter((entry) => entry !== normalized)
      doc[resource] = table
      await store.writeToml(GLOBAL_TOML, doc)
      return c.json({ ok: true, origin: normalized })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  router.post('/approvals/rule/revoke', async (c) => {
    const { resource, origin } = await c.req.json<{ resource?: unknown; origin?: unknown }>()
    if (!isBrowserResource(resource) || typeof origin !== 'string' || origin.length === 0) {
      return c.json({ error: 'resource and origin are required' }, 400)
    }
    try {
      const doc = globalDocument(await store.readToml(GLOBAL_TOML))
      const table = resourceTable(doc, resource)
      for (const key of ['allowed', 'denied'] as const) {
        table[key] = readResource(doc, resource, key).filter((entry) => entry !== origin)
      }
      doc[resource] = table
      await store.writeToml(GLOBAL_TOML, doc)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  router.post('/approvals/mode', async (c) => {
    const { resource, mode } = await c.req.json<{ resource?: unknown; mode?: unknown }>()
    if (!isBrowserMode(resource) || (mode !== 'ask' && mode !== 'never_ask')) {
      return c.json({ error: 'resource and mode are required' }, 400)
    }
    try {
      const doc = globalDocument(await store.readToml(GLOBAL_TOML))
      if (mode === DEFAULT_MODES[resource]) delete doc[MODE_KEYS[resource]]
      else doc[MODE_KEYS[resource]] = mode
      await store.writeToml(GLOBAL_TOML, doc)
      return c.json({ ok: true })
    } catch (e) {
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
   * Clear saved per-conversation site and file-transfer decisions, leaving global ones alone.
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
