export type ExternalAgentTurnStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'

export interface ExternalAgentBinding {
  agentId: string
  /** The conversation that started it; 0 when the personal assistant did (`assistantActivityId`). */
  parentChatId: number
  /** Started by the personal assistant: its Activity for this conversation. */
  assistantActivityId?: string
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
