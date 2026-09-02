// Wire DTOs for the session-independent extension management API (`/api/extensions/*`).
// Mirrors server/src/services/operon-runtime/extensions.ts.

export type OperonExtensionState = 'loaded' | 'approved' | 'new' | 'changed' | 'error'

export interface OperonExtensionDTO {
  id: string
  state: OperonExtensionState
  name?: string
  version?: string
  engine?: string
  description?: string
  error?: string
  /** Sessions currently holding this extension (an unload is refused while > 0 for service providers). */
  attachedSessions: number
}

export type ExtensionMarketplaceStatus = 'available' | 'installed' | 'update' | 'incompatible'

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
  compatibilityReason?: string
  installedVersion?: string
  installedState?: OperonExtensionState
}

export interface ExtensionMarketplaceDTO {
  generatedAt: string
  extensions: ExtensionMarketplaceEntryDTO[]
}
