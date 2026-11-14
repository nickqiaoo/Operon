// Wire DTOs for the session-independent extension management API (`/api/extensions/*`).
// Mirrors server/src/services/operon-runtime/extensions.ts.

export type OperonExtensionState = 'loaded' | 'approved' | 'new' | 'changed' | 'error'

/** What the background marketplace pass could do about a failed import. */
export type ExtensionRepairOutcome = 'unavailable' | 'unreachable' | 'failed'

export interface OperonExtensionDTO {
  id: string
  state: OperonExtensionState
  name?: string
  version?: string
  engine?: string
  description?: string
  error?: string
  /** Why the last import failed, on an entry the loader still lists as `approved`. */
  loadError?: string
  /** What the background marketplace pass could do about `loadError`, once it has run. */
  loadRepair?: ExtensionRepairOutcome
  /** Sessions currently holding this extension (an unload is refused while > 0 for service providers). */
  attachedSessions: number
  /** Its manifest declares settings: Settings offers to configure it. */
  hasSettings: boolean
}

/**
 * The JSON Schema subset an extension's manifest declares its settings in. Mirrors the
 * framework's `SettingsSchema` (operon-agents, `extensions/settings.ts`).
 */
export interface ExtensionSettingsSchema {
  type: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean'
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  properties?: Record<string, ExtensionSettingsSchema>
  required?: string[]
  additionalProperties?: ExtensionSettingsSchema
  propertyNames?: { pattern: string }
  items?: ExtensionSettingsSchema
  minimum?: number
  maximum?: number
  maxLength?: number
  pattern?: string
  /** A string whose options the host provides. */
  format?: 'model' | 'permission-mode'
  'x-multiline'?: boolean
  'x-order'?: number
}

/** One problem with a settings value, at a dotted path (`types.coder.permissionMode`; `""` is the root). */
export interface ExtensionSettingsIssue {
  path: string
  message: string
}

/** `GET /api/extensions/:id/settings`. */
export interface ExtensionSettingsDTO {
  schema: ExtensionSettingsSchema
  /** The value the extension reads: what was stored, over the defaults. */
  value: Record<string, unknown>
  /** Where the stored value did not fit the schema (those fields read as their defaults). */
  issues: ExtensionSettingsIssue[]
}

export type ExtensionMarketplaceStatus = 'available' | 'installed' | 'update'

export interface ExtensionMarketplaceEntryDTO {
  id: string
  name: string
  description: string
  version: string
  engine: string
  minOperonVersion: string
  requiresServices: string[]
  publisher: { id: string; name: string; verified: boolean }
  sha256: string
  size: number
  downloadUrl: string
  status: ExtensionMarketplaceStatus
  installedVersion?: string
  installedState?: OperonExtensionState
}

export interface ExtensionMarketplaceDTO {
  generatedAt: string
  extensions: ExtensionMarketplaceEntryDTO[]
}
