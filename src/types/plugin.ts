// Wire DTOs for the session-independent plugin management API (`/api/plugins/*`).
// Mirrors the server DTOs in server/.../operon/plugins.ts.

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

export interface OperonPluginMcpServerDTO {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  requiresAuth: boolean
  authenticated: boolean
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
  write: boolean
}

/** Full detail for an installed plugin — MCP servers, skills, and info for the detail view. */
export interface OperonPluginInfoDTO extends OperonPluginDTO {
  tagline?: string
  description?: string
  homepage?: string
  website?: string
  privacyPolicy?: string
  brandColor?: string
  keywords?: string[]
  category?: string
  developer?: string
  examplePrompts?: string[]
  installedAt?: string
  updatedAt?: string
  mcpServers: OperonPluginMcpServerDTO[]
  apps: OperonPluginAppDTO[]
  skills: string[]
}

export type ConnectorSupport = 'supported' | 'setup-required' | 'adapter-required' | 'unsupported'

export interface OperonPluginAppDTO {
  alias: string
  id: string
  required: boolean
  support: ConnectorSupport
  source?: 'connector-registry' | 'plugin-mcp'
  reason?: string
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
  connectorSupport?: ConnectorSupport
  connectorReason?: string
  appCount?: number
}

export interface MarketplaceBrowseResult {
  sources: string[]
  entries: OperonMarketplaceEntryDTO[]
  errors: Array<{ source: string; message: string }>
  /** Kept for compatibility with older servers that hid connector-only entries. */
  hidden?: number
}

/** Displayable extras (logo/description) for a marketplace entry, fetched lazily during browse. */
export interface OperonMarketplaceDetailsDTO {
  displayName?: string
  description?: string
  /** Remote logo URL (direct-URL marketplaces). */
  logoUrl?: string
  /** Local logo path (cached-repo marketplaces) — resolve to a URL via `api.pluginAssetUrl`. */
  logoAsset?: string
  brandColor?: string
}

/** An MCP server declared by a not-yet-installed marketplace entry (read-only preview — no tools). */
export interface OperonMarketplaceMcpServerDTO {
  name: string
  transport: 'stdio' | 'http'
  requiresAuth: boolean
}

/** Full detail for a not-yet-installed marketplace entry, read from the cached repo manifest. */
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
  skills: string[]
}
