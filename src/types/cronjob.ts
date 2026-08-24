export interface CronjobSchedule {
  type: 'daily'
  time: string
  days: number[]
  intervalMinutes?: number
  endTime?: string
}

export interface CronjobRunResult {
  status: 'success' | 'error'
  output?: string
  error?: string
  finishedAt: number
  durationMs: number
}

export type CronjobTaskType = 'chat' | 'canvas-workflow'

export interface CronjobTask {
  id: number
  name: string
  enabled: boolean
  taskType: CronjobTaskType
  canvasWorkflowId?: number
  workspaceId?: number
  providerId: string
  modelId?: string
  modeId?: string
  thinkingLevel?: string
  prompt: string
  schedule: CronjobSchedule
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  nextRunAt?: number
  lastResult?: CronjobRunResult
}

export interface CronjobExecutionHistoryItem {
  chatId?: number
  jobId: number
  timestamp: number
  title: string
  status: 'success' | 'error' | 'unknown'
  providerId?: string
  model?: string
}

export interface CronjobUpsertInput {
  name: string
  enabled: boolean
  taskType?: CronjobTaskType
  canvasWorkflowId?: number
  workspaceId?: number
  providerId?: string
  modelId?: string
  modeId?: string
  thinkingLevel?: string
  prompt?: string
  schedule: CronjobSchedule
}
