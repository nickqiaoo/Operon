export type ExternalAgentTurnStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'

export interface ExternalAgentBinding {
  agentId: string
  parentChatId: number
  description: string
  /** The user's choice; "default" delegates selection to the provider. */
  model: string
  lastTurn?: {
    turnId: string
    status: ExternalAgentTurnStatus
    resultMessageId?: string
    error?: string
  }
}

export interface ExternalAgentView extends ExternalAgentBinding {
  childChatId: number
  modelId?: string
  modeId?: string
  providerId: string
  workspaceId?: number
  turnId?: string
  status: ExternalAgentTurnStatus | 'idle'
  result?: string
  error?: string
}

export type ExternalAgentFrame =
  | { type: 'sync'; agents: ExternalAgentView[] }
  | { type: 'created' | 'updated'; agent: ExternalAgentView }
