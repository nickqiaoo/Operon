import {
  loadMarketplace,
  loadMarketplaceEntryDetails,
  LocalMachine,
  materializeGithubRepo,
  parseGithubMarketplaceSource,
  resolveFromFiles,
  toCoreOptions,
  type MarketplaceEntry,
  type MarketplaceEntryDetails,
  type PluginSummary,
} from 'operon-agents'
import { serverFromConfig, type MCPTool } from 'operon-agents/mcp'
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'os'
import { basename, join, resolve, sep } from 'node:path'
import { HARNESS_HOME_DIR } from './paths.js'
import { beginMcpAuth, cancelMcpAuth, disconnectMcp, hasMcpTokens, mcpAuthPending, mcpOAuthService, type BeginMcpAuthResult } from './mcp-oauth.js'
import { resolvePluginApp } from '../connectors/registry.js'
import {
  OperonPluginManager,
  readCodexDeclaredMcpServerNames,
  readCodexPluginApps,
} from './codex-plugin-apps.js'

// Cached github-repo marketplaces live here: one extracted repo per source, shared by browse+install.
const MARKETPLACE_CACHE_ROOT = join(HARNESS_HOME_DIR, 'marketplace-cache')

const APP_NAME = 'operon'

// One global PluginManager. The plugin store (installed.json + extracted dirs) lives under a single
// home dir, so every workspace shares it — and plugin management is session-independent: the Settings
// UI drives this manager directly over a chat-less route. buildHarness builds capabilities fresh per
// session and hands this SAME instance to the framework's `defaultCapabilities`, which reads its
// skills/MCP per session — so installs/enables here are observed by the next chat (no eviction).
const pluginMachine = new LocalMachine(HARNESS_HOME_DIR)
export const pluginManager = new OperonPluginManager({
  machine: pluginMachine,
  homeDir: HARNESS_HOME_DIR,
  appResolver: resolvePluginApp,
})
let loadOnce: Promise<void> | undefined

/** Load the plugin store once. Called by the harness capability factory before reading the manager. */
export async function ensurePluginsLoaded(): Promise<void> {
  loadOnce ??= pluginManager.load()
  await loadOnce
}

// ── DTOs (serializable wire shapes) ──────────────────────────────────────────
export interface OperonPluginDTO {
  id: string
  displayName: string
  version?: string
  enabled: boolean
  state: 'ok' | 'error'
  skillCount: number
  mcpServerCount: number
  enabledMcpServerCount: number
  hasErrors: boolean
  source: string
}

export interface OperonMarketplaceEntryDTO {
  id: string
  displayName: string
  source: string
  tier?: string
  version?: string
  description?: string
  homepage?: string
  keywords?: string[]
  connectorSupport?: 'supported' | 'setup-required' | 'adapter-required' | 'unsupported'
  connectorReason?: string
  appCount?: number
}

export interface OperonPluginAppDTO {
  alias: string
  id: string
  required: boolean
  support: 'supported' | 'setup-required' | 'adapter-required' | 'unsupported'
  source?: 'connector-registry' | 'plugin-mcp'
  reason?: string
}

export interface OperonPluginMcpServerDTO {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  /** The server declares OAuth (Codex `oauth_resource`) or is a remote http endpoint. */
  requiresAuth: boolean
  /** A valid OAuth token is already stored for this server. */
  authenticated: boolean
  /** A browser authorization flow is currently in progress for this server. */
  pending: boolean
}

/** Per-server MCP OAuth state — powers the Connect/Connected UI and status polling. */
export interface OperonMcpAuthServerDTO {
  server: string
  requiresAuth: boolean
  authenticated: boolean
  pending: boolean
}

/** One tool exposed by an MCP server, for the expandable capabilities view. */
export interface OperonMcpToolDTO {
  name: string
  description?: string
  /** True when the tool mutates state (from `annotations.readOnlyHint`, else a name heuristic). */
  write: boolean
}

/** Full detail for an installed plugin — powers the plugin detail view (MCP servers, skills, info). */
export interface OperonPluginInfoDTO extends OperonPluginDTO {
  /** Short one-liner shown under the title (Codex `interface.shortDescription`). */
  tagline?: string
  description?: string
  homepage?: string
  website?: string
  privacyPolicy?: string
  brandColor?: string
  keywords?: string[]
  category?: string
  developer?: string
  /** Example prompts from the Codex manifest `interface.defaultPrompt`. */
  examplePrompts?: string[]
  installedAt?: string
  updatedAt?: string
  mcpServers: OperonPluginMcpServerDTO[]
  apps: OperonPluginAppDTO[]
  /** Display names (directory basenames) of the plugin's skills. */
  skills: string[]
}

/** Displayable extras (logo/description) for a marketplace entry, fetched lazily from its manifest. */
export interface OperonMarketplaceDetailsDTO {
  displayName?: string
  description?: string
  /** Remote logo URL (direct-URL marketplaces). */
  logoUrl?: string
  /** Local logo file path (cached-repo marketplaces) — served via `GET /api/plugins/asset`. */
  logoAsset?: string
  brandColor?: string
}

/** An MCP server declared by a not-yet-installed marketplace entry (read-only preview — no tools). */
export interface OperonMarketplaceMcpServerDTO {
  name: string
  transport: 'stdio' | 'http'
  /** The server declares OAuth (`oauth_resource`) or is a remote http endpoint. */
  requiresAuth: boolean
}

/**
 * Full detail for a NOT-yet-installed marketplace entry, read straight from the cached repo manifest.
 * Powers the same detail view an installed plugin gets — description, example prompts, MCP servers,
 * skills, developer info — so a user can inspect a plugin before installing it.
 */
export interface OperonMarketplaceInfoDTO {
  description?: string
  developer?: string
  category?: string
  version?: string
  website?: string
  privacyPolicy?: string
  brandColor?: string
  examplePrompts: string[]
  mcpServers: OperonMarketplaceMcpServerDTO[]
  /** Display names (directory basenames) of the plugin's skills. */
  skills: string[]
}

function toPluginDTO(p: PluginSummary): OperonPluginDTO {
  return {
    id: p.id,
    displayName: p.displayName,
    ...(p.version ? { version: p.version } : {}),
    enabled: p.enabled,
    state: p.state,
    skillCount: p.skillCount,
    mcpServerCount: p.mcpServerCount,
    enabledMcpServerCount: p.enabledMcpServerCount,
    hasErrors: p.hasErrors,
    source: String(p.source),
  }
}

function toEntryDTO(e: MarketplaceEntry): OperonMarketplaceEntryDTO {
  return {
    id: e.id,
    displayName: e.displayName,
    source: e.source,
    ...(e.tier ? { tier: e.tier } : {}),
    ...(e.version ? { version: e.version } : {}),
    ...(e.description ? { description: e.description } : {}),
    ...(e.homepage ? { homepage: e.homepage } : {}),
    ...(e.keywords ? { keywords: [...e.keywords] } : {}),
  }
}

// ── Management (session-independent) ─────────────────────────────────────────
export async function listPlugins(): Promise<OperonPluginDTO[]> {
  await ensurePluginsLoaded()
  return pluginManager.summaries().map(toPluginDTO)
}

export async function getPluginInfo(id: string): Promise<OperonPluginInfoDTO | null> {
  await ensurePluginsLoaded()
  const info = pluginManager.info(id)
  if (info === undefined) return null
  const manifest = info.manifest
  const iface = manifest?.interface
  // Short line under the title vs the longer body paragraph — surface both, avoid duplicating them.
  const tagline = iface?.shortDescription ?? manifest?.description
  const longDesc = iface?.longDescription
  const description = longDesc && longDesc !== tagline ? longDesc : undefined
  // The typed manifest only exposes a few interface fields; category / developer / brand color /
  // example prompts live in the raw Codex manifest, so read it straight from the plugin root.
  const extra = await readCodexInterface(info.root)
  const homepage = manifest?.homepage ?? extra.website
  // Which servers declare OAuth (`oauth_resource`) in the raw .mcp.json — for the Connect affordance.
  const oauthServers = await readMcpOAuthServers(info.root)
  const mcpServers = pluginManager.mcpServerInfos(id)
  return {
    ...toPluginDTO(info),
    ...(tagline ? { tagline } : {}),
    ...(description ? { description } : {}),
    ...(homepage ? { homepage } : {}),
    ...(extra.website ? { website: extra.website } : {}),
    ...(extra.privacyPolicy ? { privacyPolicy: extra.privacyPolicy } : {}),
    ...(extra.brandColor ? { brandColor: extra.brandColor } : {}),
    ...(manifest?.keywords ? { keywords: [...manifest.keywords] } : {}),
    ...(extra.category ? { category: extra.category } : {}),
    ...(extra.developer ? { developer: extra.developer } : {}),
    ...(extra.examplePrompts.length > 0 ? { examplePrompts: extra.examplePrompts } : {}),
    ...(info.installedAt ? { installedAt: info.installedAt } : {}),
    ...(info.updatedAt ? { updatedAt: info.updatedAt } : {}),
    mcpServers: mcpServers.map((s) => {
      const requiresAuth = s.requiresAuth ?? (oauthServers.has(s.name) || s.transport === 'http')
      const authenticated = requiresAuth && s.url !== undefined ? hasMcpTokens(s.runtimeName, s.url) : false
      return { name: s.name, enabled: s.enabled, transport: s.transport, requiresAuth, authenticated, pending: mcpAuthPending(id, s.name) }
    }),
    apps: pluginManager.apps(id).map((app) => ({
      alias: app.alias,
      id: app.id,
      required: app.required,
      support: app.support,
      ...(app.source ? { source: app.source } : {}),
      ...(app.reason ? { reason: app.reason } : {}),
    })),
    skills: await resolveSkillNames(manifest?.skills ?? []),
  }
}

// ── Plugin MCP OAuth (session-independent) ───────────────────────────────────

/** Resolve a plugin's MCP server to the (runtimeName, url) the OAuth store is keyed on. */
async function resolveMcpServer(id: string, server: string): Promise<{ runtimeName: string; url: string } | null> {
  await ensurePluginsLoaded()
  const resolved = pluginManager.mcpServerConfig(id, server)
  if (resolved?.config.url === undefined) return null
  return { runtimeName: resolved.runtimeName, url: resolved.config.url }
}

export async function getMcpAuthStatus(id: string): Promise<OperonMcpAuthServerDTO[]> {
  await ensurePluginsLoaded()
  const info = pluginManager.info(id)
  if (info === undefined) return []
  const oauthServers = await readMcpOAuthServers(info.root)
  return pluginManager.mcpServerInfos(id).map((s) => {
    const requiresAuth = s.requiresAuth ?? (oauthServers.has(s.name) || s.transport === 'http')
    const authenticated = requiresAuth && s.url !== undefined ? hasMcpTokens(s.runtimeName, s.url) : false
    return { server: s.name, requiresAuth, authenticated, pending: mcpAuthPending(id, s.name) }
  })
}

export async function startMcpAuth(id: string, server: string): Promise<BeginMcpAuthResult> {
  const resolved = await resolveMcpServer(id, server)
  if (resolved === null) throw new Error(`MCP server "${server}" not found on plugin "${id}" (or it has no URL).`)
  return beginMcpAuth(id, server, resolved.runtimeName, resolved.url)
}

export async function cancelPluginMcpAuth(id: string, server: string): Promise<void> {
  await cancelMcpAuth(id, server)
}

/**
 * List the tools an installed plugin's MCP server exposes, by connecting to it once (with the shared
 * OAuth token) and calling `tools/list`. Requires the server to be reachable/authorized — an
 * OAuth-gated server that hasn't been connected yet will throw (the UI gates this on `authenticated`).
 */
export async function getMcpServerTools(id: string, server: string): Promise<OperonMcpToolDTO[]> {
  await ensurePluginsLoaded()
  const s = pluginManager.mcpServerInfos(id).find((m) => m.name === server)
  const resolved = pluginManager.mcpServerConfig(id, server)
  if (s === undefined || resolved === undefined) throw new Error(`MCP server "${server}" not found on plugin "${id}".`)
  const mcpServer = serverFromConfig(resolved.runtimeName, resolved.config, { oauthService: mcpOAuthService })
  try {
    await mcpServer.connect()
    const tools = await mcpServer.listTools()
    return tools
      .map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), write: isWriteTool(t) }))
      .sort((a, b) => (a.write === b.write ? a.name.localeCompare(b.name) : a.write ? -1 : 1))
  } finally {
    await mcpServer.close().catch(() => {})
  }
}

const WRITE_VERB = /^(create|update|delete|remove|add|set|move|archive|assign|close|reopen|comment|post|patch|write|upload|edit|rename|convert|send|start|stop|cancel|approve|reject|merge|link|unlink|import|export|sync|trigger|run|execute)/i

function isWriteTool(tool: MCPTool): boolean {
  const ann = tool['annotations']
  if (ann !== null && typeof ann === 'object') {
    const ro = (ann as Record<string, unknown>)['readOnlyHint']
    if (typeof ro === 'boolean') return !ro
  }
  return WRITE_VERB.test(tool.name)
}

/** Read a plugin skill's SKILL.md text for the expandable skill view. Null when not found. */
export async function getSkillContent(id: string, skill: string): Promise<string | null> {
  await ensurePluginsLoaded()
  const dirs = pluginManager.info(id)?.manifest?.skills ?? []
  return findSkillMd([...dirs], skill)
}

/** Locate a named skill's SKILL.md across the given skill dirs (a dir is either the skill or a container). */
async function findSkillMd(dirs: string[], skill: string): Promise<string | null> {
  for (const dir of dirs) {
    // The manifest entry may be the skill dir itself, or a container of skill subdirs.
    if (basename(dir) === skill) {
      const direct = join(dir, 'SKILL.md')
      if (await isFile(direct)) return readFile(direct, 'utf8')
    }
    try {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory() && e.name === skill) {
          const p = join(dir, e.name, 'SKILL.md')
          if (await isFile(p)) return readFile(p, 'utf8')
        }
      }
    } catch {
      // dir unreadable — try the next manifest entry
    }
  }
  return null
}

async function isFile(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function disconnectPluginMcp(id: string, server: string): Promise<void> {
  const resolved = await resolveMcpServer(id, server)
  if (resolved === null) throw new Error(`MCP server "${server}" not found on plugin "${id}" (or it has no URL).`)
  disconnectMcp(resolved.runtimeName, resolved.url)
}

// Read the server names that declare OAuth (`oauth_resource`) from the plugin's raw .mcp.json. The
// parsed config drops unknown keys, so we read the file directly. Best-effort — returns empty on miss.
async function readMcpOAuthServers(root: string): Promise<Set<string>> {
  const out = new Set<string>()
  for (const candidate of ['.mcp.json', '.codex-plugin/.mcp.json']) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(root, candidate), 'utf8'))
      const servers = typeof parsed === 'object' && parsed !== null ? (parsed as { mcpServers?: unknown }).mcpServers : undefined
      if (typeof servers !== 'object' || servers === null) continue
      for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
        if (typeof cfg === 'object' && cfg !== null && 'oauth_resource' in cfg) out.add(name)
      }
      return out
    } catch {
      // try next candidate
    }
  }
  return out
}

/**
 * A manifest `skills` entry is a directory: it either holds a SKILL.md directly (one skill named for
 * the dir) or is a container of skill subdirs (Codex `"skills": "./skills/"` → each subdir is a
 * skill). Resolve to the real skill names so the detail view lists `linear`, not `skills`.
 */
async function resolveSkillNames(skillPaths: readonly string[]): Promise<string[]> {
  const names: string[] = []
  for (const p of skillPaths) {
    if (await hasSkillMd(p)) {
      names.push(skillDisplayName(p))
      continue
    }
    try {
      const entries = await readdir(p, { withFileTypes: true })
      let found = false
      for (const e of entries) {
        if (e.isDirectory() && (await hasSkillMd(join(p, e.name)))) {
          names.push(e.name)
          found = true
        }
      }
      if (!found) names.push(skillDisplayName(p))
    } catch {
      names.push(skillDisplayName(p))
    }
  }
  return [...new Set(names)]
}

async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    await access(join(dir, 'SKILL.md'))
    return true
  } catch {
    return false
  }
}

// Manifest filenames to try, in order (Codex first, then operon). Mirrors the marketplace enrichment.
const INFO_MANIFEST_CANDIDATES = ['.codex-plugin/plugin.json', 'agents.plugin.json', '.agents-plugin/plugin.json']

interface CodexInterfaceExtras {
  category?: string
  developer?: string
  brandColor?: string
  website?: string
  privacyPolicy?: string
  examplePrompts: string[]
}

/** Read the first present raw plugin manifest from a plugin/entry root. Never throws; null on miss. */
async function readEntryManifest(root: string): Promise<Record<string, unknown> | null> {
  for (const candidate of INFO_MANIFEST_CANDIDATES) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(root, candidate), 'utf8'))
      if (isRecord(parsed)) return parsed
    } catch {
      // Missing/parse error for this candidate — try the next.
    }
  }
  return null
}

/** Read the rich Codex `interface` fields from a plugin's raw manifest for the detail view. Never throws. */
async function readCodexInterface(root: string): Promise<CodexInterfaceExtras> {
  const manifest = await readEntryManifest(root)
  return manifest ? extractCodexInterface(manifest) : { examplePrompts: [] }
}

/** Pull the Codex `interface` extras out of an already-parsed manifest record. */
function extractCodexInterface(manifest: Record<string, unknown>): CodexInterfaceExtras {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined)
  const rec = isRecord(manifest['interface']) ? manifest['interface'] : {}
  const rawPrompt = rec['defaultPrompt']
  const examplePrompts = (Array.isArray(rawPrompt) ? rawPrompt : typeof rawPrompt === 'string' ? [rawPrompt] : [])
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
  return {
    category: str(rec['category']),
    developer: str(rec['developerName']),
    brandColor: str(rec['brandColor']),
    website: str(rec['websiteURL']),
    privacyPolicy: str(rec['privacyPolicyURL']),
    examplePrompts,
  }
}

// A manifest skill entry is an absolute path to a skill dir (or its SKILL.md). Show the dir name.
function skillDisplayName(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s.length > 0)
  const last = parts[parts.length - 1] ?? p
  if (/^skill\.md$/i.test(last)) return parts[parts.length - 2] ?? last
  return last
}

export async function installPlugin(source: string): Promise<OperonPluginDTO> {
  await ensurePluginsLoaded()
  const record = await pluginManager.install(source)
  const summary = pluginManager.summaries().find((p) => p.id === record.id)
  if (!summary) throw new Error(`Plugin "${record.id}" installed but missing from summaries`)
  return toPluginDTO(summary)
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  await ensurePluginsLoaded()
  await pluginManager.setEnabled(id, enabled)
}

export async function setPluginMcpEnabled(id: string, server: string, enabled: boolean): Promise<void> {
  await ensurePluginsLoaded()
  await pluginManager.setMcpServerEnabled(id, server, enabled)
}

export async function removePlugin(id: string): Promise<void> {
  await ensurePluginsLoaded()
  await pluginManager.remove(id)
}

export async function reloadPlugins(): Promise<void> {
  await ensurePluginsLoaded()
  await pluginManager.reload()
}

/**
 * Browse plugin marketplaces. With no explicit source, reads the registries configured in the
 * user-tier `~/.operon/config.toml` (`pluginMarketplaces`). Each registry is loaded independently;
 * a failing one is reported in `errors` rather than failing the whole browse.
 */
export async function browseMarketplaces(
  explicitSource?: string,
): Promise<{ sources: string[]; entries: OperonMarketplaceEntryDTO[]; errors: Array<{ source: string; message: string }>; hidden: number }> {
  const sources = explicitSource ? [explicitSource] : await configuredMarketplaces()
  const entries: OperonMarketplaceEntryDTO[] = []
  const errors: Array<{ source: string; message: string }> = []
  let hidden = 0
  for (const source of sources) {
    try {
      // A marketplace is a github plugin repo (monorepo): cache the whole repo ONCE, then read its
      // index + plugins locally (entry sources become local paths → install is a local copy, no
      // per-plugin download, no per-plugin raw fetch).
      const gh = parseGithubMarketplaceSource(source)
      if (gh === undefined) {
        throw new Error(`Marketplace must be a github plugin repo, e.g. "openai/plugins" (got "${source}").`)
      }
      const repoDir = await ensureMarketplaceRepo(gh)
      const marketplace = await loadMarketplace({ source, repoDir })
      const connectorStates = await Promise.all(
        marketplace.plugins.map(async (entry) => {
          const dir = marketplaceEntryDir(entry.source)
          return dir === null ? undefined : assessMarketplaceApps(dir)
        }),
      )
      marketplace.plugins.forEach((entry, i) => {
        const connectorState = connectorStates[i]
        // A required App the agent can't reach makes install throw, so the card would be a dead
        // end: hide it and only report the count. `undefined` means the plugin declares no Apps
        // at all (plain MCP plugin) — always listed.
        if (connectorState !== undefined && connectorState.connectorSupport !== 'supported') {
          hidden += 1
          return
        }
        entries.push({
          ...toEntryDTO(entry),
          ...(connectorState ?? {}),
        })
      })
    } catch (error) {
      errors.push({ source, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { sources, entries, errors, hidden }
}

async function assessMarketplaceApps(
  root: string,
): Promise<Pick<OperonMarketplaceEntryDTO, 'connectorSupport' | 'connectorReason' | 'appCount'> | undefined> {
  const apps = await readCodexPluginApps(root)
  if (apps.length === 0) return undefined
  const mcpServers = await readCodexDeclaredMcpServerNames(root)
  const resolutions = await Promise.all(apps.map(async (app) => (
    mcpServers.has(app.alias)
      ? { support: 'supported' as const, reason: 'The plugin provides its own MCP server.' }
      : resolvePluginApp(app)
  )))
  const required = apps
    .map((app, index) => ({ app, resolution: resolutions[index]! }))
    .filter(({ app }) => app.required)
  const blocked = required.find(({ resolution }) => resolution.support !== 'supported')
  return {
    connectorSupport: blocked?.resolution.support ?? 'supported',
    ...(blocked?.resolution.reason ? { connectorReason: blocked.resolution.reason } : {}),
    appCount: apps.length,
  }
}

async function configuredMarketplaces(): Promise<string[]> {
  // User-tier config (`~/.operon/config.toml`) is read regardless of cwd; pass home as a stable cwd.
  try {
    const { config } = await resolveFromFiles({ appName: APP_NAME, cwd: os.homedir() })
    return [...toCoreOptions(config).pluginMarketplaces]
  } catch {
    return []
  }
}

// ── Cached github-repo marketplaces ──────────────────────────────────────────
// A github-repo marketplace is a monorepo (the repo IS the registry; plugins are subdirs). We
// download+extract it ONCE per source into the cache, reused by both browse and install. Refreshed
// when older than the TTL so newly-published plugins eventually appear.
const REPO_CACHE_TTL_MS = 24 * 60 * 60 * 1000

async function ensureMarketplaceRepo(gh: { owner: string; repo: string; ref?: string }): Promise<string> {
  const refVal = gh.ref ?? 'HEAD'
  const key = `${gh.owner}-${gh.repo}-${refVal}`.replace(/[^\w.-]/g, '_')
  const dest = join(MARKETPLACE_CACHE_ROOT, key)
  const metaPath = join(MARKETPLACE_CACHE_ROOT, `${key}.json`)
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { root: string; at: number }
    if (Date.now() - meta.at < REPO_CACHE_TTL_MS) {
      await access(meta.root)
      return meta.root
    }
  } catch {
    // missing / stale / corrupt cache → (re)download below
  }
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  const root = await materializeGithubRepo({ owner: gh.owner, repo: gh.repo, ref: gh.ref, destDir: dest })
  await writeFile(metaPath, JSON.stringify({ root, at: Date.now() }))
  return root
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
}

/** Read a plugin logo (or other image) from the marketplace cache. Refuses paths outside the cache. */
export async function getMarketplaceAsset(path: string): Promise<{ data: Buffer; contentType: string } | null> {
  const abs = resolve(path)
  const root = resolve(MARKETPLACE_CACHE_ROOT)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  const contentType = ASSET_CONTENT_TYPES[abs.slice(abs.lastIndexOf('.')).toLowerCase()]
  if (contentType === undefined) return null
  try {
    return { data: await readFile(abs), contentType }
  } catch {
    return null
  }
}

// ── Marketplace entry details (logo / description), fetched lazily ────────────
// Registry indices only list id/source; logo+description live in each plugin's own manifest. We
// fetch them on demand while browsing, capped concurrency, and cache by source (incl. `null` misses)
// so re-browsing is instant.
const detailsCache = new Map<string, OperonMarketplaceDetailsDTO | null>()

export async function getMarketplaceEntryDetails(
  sources: string[],
): Promise<Record<string, OperonMarketplaceDetailsDTO>> {
  const missing = [...new Set(sources)].filter((s) => !detailsCache.has(s))
  await mapWithConcurrency(missing, 8, async (src) => {
    const details = await loadMarketplaceEntryDetails(src).catch(() => null)
    detailsCache.set(src, details ? toDetailsDTO(details) : null)
  })
  const out: Record<string, OperonMarketplaceDetailsDTO> = {}
  for (const src of sources) {
    const cached = detailsCache.get(src)
    if (cached) out[src] = cached
  }
  return out
}

function toDetailsDTO(d: MarketplaceEntryDetails): OperonMarketplaceDetailsDTO {
  return {
    ...(d.displayName ? { displayName: d.displayName } : {}),
    ...(d.description ? { description: d.description } : {}),
    ...(d.logoUrl ? { logoUrl: d.logoUrl } : {}),
    ...(d.logoPath ? { logoAsset: d.logoPath } : {}),
    ...(d.brandColor ? { brandColor: d.brandColor } : {}),
  }
}

// ── Full detail for a not-yet-installed marketplace entry ────────────────────
// The cached marketplace repo already holds each plugin's full manifest (`.codex-plugin/plugin.json`,
// `.mcp.json`, `skills/`). For a `local` entry (its `source` is an absolute path in the cache) we can
// read the SAME rich detail an installed plugin exposes — WITHOUT installing. MCP servers are a
// read-only preview (tools need a live connection, so they aren't listed until the plugin is
// installed + authorized). Returns null for non-local entries (git-subdir/url) or a missing manifest.

/** Resolve a marketplace entry `source` to a readable local dir, refusing anything outside the cache. */
function marketplaceEntryDir(source: string): string | null {
  const abs = resolve(source)
  const root = resolve(MARKETPLACE_CACHE_ROOT)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

export async function getMarketplaceEntryInfo(source: string): Promise<OperonMarketplaceInfoDTO | null> {
  const root = marketplaceEntryDir(source)
  if (root === null) return null
  const manifest = await readEntryManifest(root)
  if (manifest === null) return null
  const iface = isRecord(manifest['interface']) ? manifest['interface'] : {}
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined)
  // Show the long description only when it adds something beyond the tagline already in the header.
  const tagline = str(iface['shortDescription']) ?? str(manifest['description'])
  const longDesc = str(iface['longDescription'])
  const description = longDesc && longDesc !== tagline ? longDesc : undefined
  const extra = extractCodexInterface(manifest)
  return {
    ...(description ? { description } : {}),
    ...(extra.developer ? { developer: extra.developer } : {}),
    ...(extra.category ? { category: extra.category } : {}),
    ...(str(manifest['version']) ? { version: str(manifest['version']) } : {}),
    ...(extra.website ? { website: extra.website } : {}),
    ...(extra.privacyPolicy ? { privacyPolicy: extra.privacyPolicy } : {}),
    ...(extra.brandColor ? { brandColor: extra.brandColor } : {}),
    examplePrompts: extra.examplePrompts,
    mcpServers: await readMarketplaceMcpServers(root),
    skills: await resolveSkillNames(manifestSkillPaths(root, manifest['skills'])),
  }
}

/** Read a not-yet-installed entry's skill SKILL.md straight from the cached repo. Null when not found. */
export async function getMarketplaceSkillContent(source: string, skill: string): Promise<string | null> {
  const root = marketplaceEntryDir(source)
  if (root === null) return null
  const manifest = await readEntryManifest(root)
  if (manifest === null) return null
  return findSkillMd(manifestSkillPaths(root, manifest['skills']), skill)
}

/** A manifest `skills` field (string container or array) → absolute skill dirs under the plugin root. */
function manifestSkillPaths(root: string, raw: unknown): string[] {
  const rels = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return rels
    .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    .map((r) => resolve(root, r.trim().replace(/^\.?\/+/, '')))
}

/** Preview declared MCP servers plus portable app connectors (name/transport/auth only). */
async function readMarketplaceMcpServers(root: string): Promise<OperonMarketplaceMcpServerDTO[]> {
  const out: OperonMarketplaceMcpServerDTO[] = []
  for (const candidate of ['.mcp.json', '.codex-plugin/.mcp.json']) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(root, candidate), 'utf8'))
      const servers = isRecord(parsed) ? parsed['mcpServers'] : undefined
      if (!isRecord(servers)) continue
      out.push(...Object.entries(servers).map(([name, cfg]) => {
        const rec = isRecord(cfg) ? cfg : {}
        const transport: 'stdio' | 'http' = rec['type'] === 'http' || typeof rec['url'] === 'string' ? 'http' : 'stdio'
        return { name, transport, requiresAuth: 'oauth_resource' in rec || transport === 'http' }
      }))
      break
    } catch {
      // try next candidate
    }
  }
  const apps = (await readCodexPluginApps(root)).filter((app) => !out.some((server) => server.name === app.alias))
  const resolutions = await Promise.all(apps.map((app) => resolvePluginApp(app)))
  for (const [index, app] of apps.entries()) {
    const resolution = resolutions[index]!
    if (resolution.support === 'supported' && resolution.mcpServer !== undefined) {
      out.push({
        name: app.alias,
        transport: resolution.mcpServer.transport,
        requiresAuth: resolution.requiresAuth ?? resolution.mcpServer.transport === 'http',
      })
    }
  }
  return [...out].sort((a, b) => a.name.localeCompare(b.name))
}

/** Run `fn` over `items` with at most `limit` in flight. No external dep. */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      if (item !== undefined) await fn(item)
    }
  })
  await Promise.all(workers)
}
