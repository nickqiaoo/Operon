import { PluginManager, type McpServerConfig } from 'operon-agents'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  resolvePluginApp,
  type CodexPluginAppRef,
  type PluginAppResolution,
  type ResolvedPluginApp,
} from '../connectors/registry.js'

interface DynamicMcpServer {
  config: McpServerConfig
  requiresAuth?: boolean
}

interface PluginAppRuntime {
  apps: readonly ResolvedPluginApp[]
  dynamicMcpServers: Readonly<Record<string, DynamicMcpServer>>
  blockedApp?: ResolvedPluginApp
}

interface PersistedAppMcpState {
  version: 1
  plugins: Record<string, Record<string, { enabled: boolean }>>
}

export interface OperonPluginMcpServerInfo {
  name: string
  runtimeName: string
  enabled: boolean
  transport: 'stdio' | 'http'
  url?: string
  requiresAuth?: boolean
}

type BasePluginManagerOptions = ConstructorParameters<typeof PluginManager>[0]

export interface OperonPluginManagerOptions extends BasePluginManagerOptions {
  appResolver?: (app: CodexPluginAppRef) => Promise<PluginAppResolution>
}

const MANIFEST_CANDIDATES = ['.codex-plugin/plugin.json', 'agents.plugin.json', '.agents-plugin/plugin.json']

/**
 * Operon's Codex App Connector adapter. The framework manager still owns only normalized plugin
 * contributions; this upper layer interprets `.app.json`, applies Operon's connector policy, and
 * projects compatible App Connectors into ordinary namespaced MCP configs.
 */
export class OperonPluginManager extends PluginManager {
  private readonly appResolver: (app: CodexPluginAppRef) => Promise<PluginAppResolution>
  private readonly appStatePath: string
  private appRuntime = new Map<string, PluginAppRuntime>()
  private persistedState: PersistedAppMcpState = { version: 1, plugins: {} }
  private persistedStateLoaded?: Promise<void>

  constructor(options: OperonPluginManagerOptions) {
    const { appResolver = resolvePluginApp, ...baseOptions } = options
    super(baseOptions)
    this.appResolver = appResolver
    this.appStatePath = join(options.homeDir, 'plugins', 'app-mcp-state.json')
  }

  override async load(): Promise<void> {
    await super.load()
    await this.refreshAppRuntime()
  }

  override async install(source: string): Promise<Awaited<ReturnType<PluginManager['install']>>> {
    await this.rejectUnsupportedLocalSource(source)
    const installedBefore = new Set(this.list().map((record) => record.id))
    const record = await super.install(source)
    await this.refreshAppRuntime()
    const blocked = this.appRuntime.get(record.id)?.blockedApp
    if (blocked !== undefined) {
      if (!installedBefore.has(record.id)) {
        await this.remove(record.id)
      }
      throw unsupportedRequiredAppError(source, blocked)
    }
    return record
  }

  override async reload(): Promise<Awaited<ReturnType<PluginManager['reload']>>> {
    const summary = await super.reload()
    await this.refreshAppRuntime()
    return summary
  }

  override async remove(id: string): Promise<void> {
    await super.remove(id)
    this.appRuntime.delete(normalizeId(id))
    delete this.persistedState.plugins[normalizeId(id)]
    await this.persistAppState()
  }

  override async setMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void> {
    const key = normalizeId(id)
    if (this.appRuntime.get(key)?.dynamicMcpServers[server] === undefined) {
      await super.setMcpServerEnabled(id, server, enabled)
      return
    }
    const pluginState = this.persistedState.plugins[key] ?? {}
    this.persistedState.plugins[key] = { ...pluginState, [server]: { enabled } }
    await this.persistAppState()
  }

  override skillRoots() {
    return super.skillRoots().filter((root) => root.plugin === undefined || !this.isBlocked(root.plugin.id))
  }

  override mcpServerConfigs(): Record<string, McpServerConfig> {
    const out = super.mcpServerConfigs()
    for (const id of this.blockedPluginIds()) {
      const prefix = `plugin-${id}:`
      for (const runtimeName of Object.keys(out)) {
        if (runtimeName.startsWith(prefix)) delete out[runtimeName]
      }
    }
    for (const record of this.list()) {
      if (!record.enabled || record.state !== 'ok' || this.isBlocked(record.id)) continue
      for (const [name, server] of Object.entries(this.appRuntime.get(record.id)?.dynamicMcpServers ?? {})) {
        if (!this.isMcpServerEnabled(record.id, name)) continue
        out[runtimeName(record.id, name)] = { ...server.config, enabled: true }
      }
    }
    return out
  }

  override sessionStarts(): ReturnType<PluginManager['sessionStarts']> {
    return super.sessionStarts().filter((entry) => !this.isBlocked(entry.pluginId))
  }

  override hookDefs() {
    return [...this.list()]
      .filter((record) => record.enabled && record.state === 'ok' && !this.isBlocked(record.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .flatMap((record) => record.manifest?.hooks ?? [])
  }

  override summaries(): ReturnType<PluginManager['summaries']> {
    return super.summaries().map((summary) => this.decorateSummary(summary))
  }

  override info(id: string): ReturnType<PluginManager['info']> {
    const info = super.info(id)
    if (info === undefined) return undefined
    return {
      ...this.decorateSummary(info),
      root: info.root,
      installedAt: info.installedAt,
      updatedAt: info.updatedAt,
      manifestPath: info.manifestPath,
      manifest: info.manifest,
      mcpServers: this.mcpServerInfos(id).map((server) => ({
        name: server.name,
        runtimeName: server.runtimeName,
        enabled: server.enabled,
        transport: server.transport,
        ...(server.url !== undefined ? { url: server.url } : {}),
      })),
      diagnostics: info.diagnostics,
    }
  }

  apps(id: string): readonly ResolvedPluginApp[] {
    return this.appRuntime.get(normalizeId(id))?.apps ?? []
  }

  blockedApp(id: string): ResolvedPluginApp | undefined {
    return this.appRuntime.get(normalizeId(id))?.blockedApp
  }

  mcpServerInfos(id: string): readonly OperonPluginMcpServerInfo[] {
    const key = normalizeId(id)
    const record = this.get(key)
    if (record === undefined) return []
    const declared = Object.entries(record.manifest?.mcpServers ?? {}).map(([name, config]) => ({
      name,
      runtimeName: runtimeName(key, name),
      enabled: record.capabilities?.mcpServers?.[name]?.enabled ?? config.enabled !== false,
      transport: config.transport,
      ...(config.url !== undefined ? { url: config.url } : {}),
    }))
    const dynamic = Object.entries(this.appRuntime.get(key)?.dynamicMcpServers ?? {}).map(([name, server]) => ({
      name,
      runtimeName: runtimeName(key, name),
      enabled: this.isMcpServerEnabled(key, name),
      transport: server.config.transport,
      ...(server.config.url !== undefined ? { url: server.config.url } : {}),
      ...(server.requiresAuth !== undefined ? { requiresAuth: server.requiresAuth } : {}),
    }))
    return [...declared, ...dynamic].sort((a, b) => a.name.localeCompare(b.name))
  }

  mcpServerConfig(id: string, server: string): { runtimeName: string; config: McpServerConfig } | undefined {
    const key = normalizeId(id)
    const record = this.get(key)
    if (record === undefined || !record.enabled || record.state !== 'ok' || this.isBlocked(key)) return undefined
    const declared = record.manifest?.mcpServers?.[server]
    if (declared !== undefined) {
      const enabled = record.capabilities?.mcpServers?.[server]?.enabled ?? declared.enabled !== false
      return enabled ? { runtimeName: runtimeName(key, server), config: declared } : undefined
    }
    const config = this.appRuntime.get(key)?.dynamicMcpServers[server]?.config
    if (config === undefined || !this.isMcpServerEnabled(key, server)) return undefined
    return { runtimeName: runtimeName(key, server), config }
  }

  private async refreshAppRuntime(): Promise<void> {
    await this.loadPersistedState()
    const entries = await Promise.all(this.list().map(async (record) => {
      const refs = await readCodexPluginApps(record.root)
      const apps = await Promise.all(refs.map(async (app): Promise<ResolvedPluginApp> => {
        if (record.manifest?.mcpServers?.[app.alias] !== undefined) {
          return {
            ...app,
            support: 'supported',
            source: 'plugin-mcp',
            connectorId: app.id,
            reason: 'The plugin provides its own MCP server.',
          }
        }
        try {
          return { ...app, ...(await this.appResolver(app)) }
        } catch (error) {
          return {
            ...app,
            support: 'unsupported',
            reason: error instanceof Error ? error.message : String(error),
          }
        }
      }))
      const dynamicMcpServers: Record<string, DynamicMcpServer> = {}
      for (const app of apps) {
        if (record.manifest?.mcpServers?.[app.alias] === undefined && app.support === 'supported' && app.mcpServer !== undefined) {
          dynamicMcpServers[app.alias] = {
            config: app.mcpServer,
            ...(app.requiresAuth !== undefined ? { requiresAuth: app.requiresAuth } : {}),
          }
        }
      }
      const blockedApp = apps.find((app) => app.required && app.support !== 'supported')
      return [record.id, {
        apps,
        dynamicMcpServers,
        ...(blockedApp !== undefined ? { blockedApp } : {}),
      }] as const
    }))
    this.appRuntime = new Map(entries)
  }

  private async rejectUnsupportedLocalSource(source: string): Promise<void> {
    const root = resolve(source)
    try {
      if (!(await stat(root)).isDirectory()) return
    } catch {
      return
    }
    const declaredMcpServers = await readCodexDeclaredMcpServerNames(root)
    const refs = await readCodexPluginApps(root)
    const apps = await Promise.all(refs.map(async (app): Promise<ResolvedPluginApp> => {
      if (declaredMcpServers.has(app.alias)) {
        return { ...app, support: 'supported', source: 'plugin-mcp', connectorId: app.id }
      }
      try {
        return { ...app, ...(await this.appResolver(app)) }
      } catch (error) {
        return { ...app, support: 'unsupported', reason: error instanceof Error ? error.message : String(error) }
      }
    }))
    const blocked = apps.find((app) => app.required && app.support !== 'supported')
    if (blocked !== undefined) throw unsupportedRequiredAppError(source, blocked)
  }

  private isBlocked(id: string): boolean {
    return this.appRuntime.get(normalizeId(id))?.blockedApp !== undefined
  }

  private blockedPluginIds(): string[] {
    return [...this.appRuntime.entries()].filter(([, state]) => state.blockedApp !== undefined).map(([id]) => id)
  }

  private isMcpServerEnabled(id: string, server: string, config?: McpServerConfig): boolean {
    return this.persistedState.plugins[normalizeId(id)]?.[server]?.enabled ?? config?.enabled !== false
  }

  private async loadPersistedState(): Promise<void> {
    this.persistedStateLoaded ??= (async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(this.appStatePath, 'utf8'))
        if (isRecord(parsed) && parsed['version'] === 1 && isRecord(parsed['plugins'])) {
          this.persistedState = parsed as unknown as PersistedAppMcpState
        }
      } catch {
        this.persistedState = { version: 1, plugins: {} }
      }
    })()
    await this.persistedStateLoaded
  }

  private async persistAppState(): Promise<void> {
    await this.loadPersistedState()
    await mkdir(dirname(this.appStatePath), { recursive: true })
    await writeFile(this.appStatePath, JSON.stringify(this.persistedState, null, 2))
  }

  private decorateSummary<T extends ReturnType<PluginManager['summaries']>[number]>(summary: T): T {
    const servers = this.mcpServerInfos(summary.id)
    const blocked = this.blockedApp(summary.id)
    return {
      ...summary,
      state: blocked === undefined ? summary.state : 'error',
      mcpServerCount: servers.length,
      enabledMcpServerCount: servers.filter((server) => server.enabled).length,
      hasErrors: summary.hasErrors || blocked !== undefined,
    }
  }
}

export async function readCodexPluginApps(root: string): Promise<CodexPluginAppRef[]> {
  const manifest = await readPluginManifest(root)
  if (manifest === null) return []
  let raw = manifest['apps']
  if (typeof raw === 'string') {
    const appPath = safePluginPath(root, raw)
    if (appPath === undefined) return []
    try {
      const parsed: unknown = JSON.parse(await readFile(appPath, 'utf8'))
      raw = isRecord(parsed) && isRecord(parsed['apps']) ? parsed['apps'] : parsed
    } catch {
      return []
    }
  }
  if (!isRecord(raw)) return []
  const apps: CodexPluginAppRef[] = []
  for (const [rawAlias, value] of Object.entries(raw)) {
    const alias = rawAlias.trim()
    const id = typeof value === 'string'
      ? value.trim()
      : isRecord(value) && typeof value['id'] === 'string'
        ? value['id'].trim()
        : ''
    if (alias.length === 0 || id.length === 0) continue
    const required = isRecord(value) && typeof value['required'] === 'boolean'
      ? value['required']
      : !(isRecord(value) && value['optional'] === true)
    apps.push({ alias, id, required })
  }
  return apps
}

export async function readCodexDeclaredMcpServerNames(root: string): Promise<Set<string>> {
  const manifest = await readPluginManifest(root)
  if (manifest === null) return new Set()
  let raw = manifest['mcpServers']
  if (typeof raw === 'string') {
    const mcpPath = safePluginPath(root, raw)
    if (mcpPath === undefined) return new Set()
    try {
      const parsed: unknown = JSON.parse(await readFile(mcpPath, 'utf8'))
      raw = isRecord(parsed) && isRecord(parsed['mcpServers']) ? parsed['mcpServers'] : parsed
    } catch {
      return new Set()
    }
  }
  return isRecord(raw) ? new Set(Object.keys(raw)) : new Set()
}

async function readPluginManifest(root: string): Promise<Record<string, unknown> | null> {
  for (const candidate of MANIFEST_CANDIDATES) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(root, candidate), 'utf8'))
      if (isRecord(parsed)) return parsed
    } catch {
      // Try the next supported plugin manifest location.
    }
  }
  return null
}

function safePluginPath(root: string, rawPath: string): string | undefined {
  if (!rawPath.startsWith('./')) return undefined
  const absolute = resolve(root, rawPath)
  const rel = relative(resolve(root), absolute)
  const escapesRoot = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  return escapesRoot ? undefined : absolute
}

function unsupportedRequiredAppError(source: string, app: ResolvedPluginApp): Error {
  return new Error(`Cannot install plugin from ${source}: app "${app.alias}" is not supported. ${app.reason ?? ''}`.trim())
}

function runtimeName(pluginId: string, serverName: string): string {
  return `plugin-${pluginId}:${serverName}`
}

function normalizeId(id: string): string {
  return id.toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
