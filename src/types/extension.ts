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
