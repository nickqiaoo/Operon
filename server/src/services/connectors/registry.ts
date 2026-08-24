import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { McpServerConfig } from 'operon-agents'

export interface CodexPluginAppRef {
  alias: string
  id: string
  required: boolean
}

export type PluginAppSupport = 'supported' | 'setup-required' | 'adapter-required' | 'unsupported'
export type PluginAppSource = 'connector-registry' | 'plugin-mcp'

export interface PluginAppResolution {
  support: PluginAppSupport
  source?: PluginAppSource
  connectorId?: string
  reason?: string
  requiresAuth?: boolean
  mcpServer?: McpServerConfig
}

export interface ResolvedPluginApp extends CodexPluginAppRef, PluginAppResolution {}

export interface ConnectorRegistryEntry {
  appId: string
  resolvedConnectorId?: string
  name?: string
  status?: string
  portability?: string
  connectorType?: string
  service?: string
  baseUrl?: string
  transport?: string
  authMode?: string
  pluginMcpFallback?: {
    type?: string
    url?: string
    oauthResource?: string
    source?: string
  } | null
  actionSchemasAvailable?: boolean
  actionCount?: number
}

export interface ConnectorDescriptor {
  id: string
  connectorId?: string
  name?: string
  support: PluginAppSupport
  reason?: string
  transport?: string
  authMode?: string
  endpoint?: string
  actionSchemasAvailable: boolean
  actionCount: number
}

interface RegistryDocument {
  schemaVersion?: number
  generatedAt?: string
  connectors: ConnectorRegistryEntry[]
}

let registryPromise: Promise<RegistryDocument> | undefined

export async function resolvePluginApp(app: CodexPluginAppRef): Promise<PluginAppResolution> {
  const entry = await findConnector(app.id)
  if (entry === undefined) {
    return {
      support: 'unsupported',
      reason: `Connector metadata is unavailable for ${app.id}.`,
    }
  }
  const assessment = assessConnector(entry)
  if (assessment.support !== 'supported' || entry.baseUrl === undefined) {
    return {
      ...assessment,
      connectorId: entry.resolvedConnectorId ?? entry.appId,
      source: 'connector-registry',
    }
  }
  return {
    ...assessment,
    connectorId: entry.resolvedConnectorId ?? entry.appId,
    source: 'connector-registry',
    requiresAuth: entry.authMode !== 'no-auth',
    mcpServer: {
      transport: 'http',
      url: entry.baseUrl,
    },
  }
}

export async function getConnectorDescriptor(id: string): Promise<ConnectorDescriptor | undefined> {
  const entry = await findConnector(id)
  if (entry === undefined) return undefined
  const assessment = assessConnector(entry)
  return {
    id: entry.appId,
    ...(entry.resolvedConnectorId ? { connectorId: entry.resolvedConnectorId } : {}),
    ...(entry.name ? { name: entry.name } : {}),
    ...assessment,
    ...(entry.transport ? { transport: entry.transport } : {}),
    ...(entry.authMode ? { authMode: entry.authMode } : {}),
    ...(entry.baseUrl ? { endpoint: entry.baseUrl } : {}),
    actionSchemasAvailable: entry.actionSchemasAvailable === true,
    actionCount: entry.actionCount ?? 0,
  }
}

export async function findConnector(id: string): Promise<ConnectorRegistryEntry | undefined> {
  const registry = await loadRegistry()
  return registry.connectors.find((entry) => entry.appId === id || entry.resolvedConnectorId === id)
}

function assessConnector(entry: ConnectorRegistryEntry): Pick<PluginAppResolution, 'support' | 'reason'> {
  if (entry.portability === 'openai-adapter') {
    return {
      support: 'adapter-required',
      reason: 'This connector requires a native OpenAI adapter that Operon does not provide yet.',
    }
  }
  if (entry.portability === 'requires-vendor-oauth-client') {
    return {
      support: 'setup-required',
      reason: 'This connector requires a vendor-registered OAuth client.',
    }
  }
  if (entry.portability !== 'direct-mcp-candidate' || entry.baseUrl === undefined) {
    return {
      support: 'unsupported',
      reason: 'This connector does not expose a portable MCP endpoint.',
    }
  }
  if (entry.transport !== 'streamable-http') {
    return {
      support: 'unsupported',
      reason: 'Legacy SSE connectors are not supported in this phase.',
    }
  }
  if (!['no-auth', 'dcr', 'cimd'].includes(entry.authMode ?? '')) {
    return {
      support: 'unsupported',
      reason: `Authentication mode ${entry.authMode ?? 'unknown'} is not supported.`,
    }
  }
  return { support: 'supported' }
}

async function loadRegistry(): Promise<RegistryDocument> {
  registryPromise ??= readRegistry()
  return registryPromise
}

async function readRegistry(): Promise<RegistryDocument> {
  const registryPath = await locateRegistry()
  const raw: unknown = JSON.parse(await readFile(registryPath, 'utf8'))
  if (!isRecord(raw) || !Array.isArray(raw['connectors'])) {
    throw new Error(`Invalid connector registry at ${registryPath}.`)
  }
  const connectors = raw['connectors'].filter(isConnectorEntry)
  return {
    ...(typeof raw['schemaVersion'] === 'number' ? { schemaVersion: raw['schemaVersion'] } : {}),
    ...(typeof raw['generatedAt'] === 'string' ? { generatedAt: raw['generatedAt'] } : {}),
    connectors,
  }
}

async function locateRegistry(): Promise<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    process.env.OPERON_CONNECTOR_REGISTRY_PATH,
    resourcesPath ? path.join(resourcesPath, 'operon-runtime', 'connectors', 'connectors.index.json') : undefined,
    path.join(process.cwd(), 'server', 'src', 'services', 'connectors', 'connectors.index.json'),
    path.join(process.cwd(), 'dist-operon-runtime', 'connectors', 'connectors.index.json'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)

  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next development or packaged location.
    }
  }
  throw new Error('Connector registry not found.')
}

function isConnectorEntry(value: unknown): value is ConnectorRegistryEntry {
  return isRecord(value) && typeof value['appId'] === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
