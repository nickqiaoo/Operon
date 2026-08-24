export interface MemoryMaintenanceConfig {
  enabled: boolean
  scheduleTime: string
  providerId?: string
  modelId?: string
  layer1Enabled: boolean
  maxSessionsPerRun: number
  updatedAt: number
}

export type MemoryMaintenanceLayer = 'extract' | 'consolidate' | 'full'
export type MemoryMaintenanceStatus = 'running' | 'success' | 'error' | 'aborted'
export type MemoryMaintenanceTrigger = 'scheduled' | 'manual'

export interface MemoryMaintenanceRun {
  id: number
  startedAt: number
  finishedAt?: number
  layer: MemoryMaintenanceLayer
  providerId?: string
  modelId?: string
  sessionsProcessed: number
  chunksProcessed: number
  memoriesWritten: number
  memoriesMerged: number
  tokensInput: number
  tokensOutput: number
  status: MemoryMaintenanceStatus
  trigger: MemoryMaintenanceTrigger
  error?: string
}

export interface CreateMemoryMaintenanceRunInput {
  startedAt: number
  layer: MemoryMaintenanceLayer
  providerId?: string
  modelId?: string
  trigger: MemoryMaintenanceTrigger
}

export interface UpdateMemoryMaintenanceRunInput {
  finishedAt?: number
  sessionsProcessed?: number
  chunksProcessed?: number
  memoriesWritten?: number
  memoriesMerged?: number
  tokensInput?: number
  tokensOutput?: number
  status?: MemoryMaintenanceStatus
  error?: string
}

export interface ChatExtractionCandidate {
  chatId: number
  title: string
  providerId?: string
  updatedAt: number
  totalMessages: number
  lastExtractedMessageIndex: number | null
}
