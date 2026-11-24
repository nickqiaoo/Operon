import type { RemoteAgentLocation, RemoteAgentParent } from './delegations.js'

export type ExternalAgentTurnStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
export const SUPPORTED_EXTERNAL_AGENT_IDS = ['codex', 'claude-code', 'opencode', 'kimi', 'cursor', 'grok', 'copilot', 'antigravity', 'qoder'] as const

export interface ExternalAgentBinding {
  agentId: string
  /** The conversation that started it; 0 when the personal assistant did (`assistantActivityId`). */
  parentChatId: number
  /** Started by the personal assistant: its Activity for this conversation. */
  assistantActivityId?: string
  /**
   * Started by a conversation on another machine of the account (`parentChatId`
   * is then 0): that machine is told of each turn and gets its results.
   */
  remoteParent?: RemoteAgentParent
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
  /** When the child conversation last changed: newest first in its parent's Agents list. */
  updatedAt?: number
  /**
   * Lives on another machine of the account: `childChatId` and `workspaceId`
   * are that machine's, and its conversation opens there.
   */
  remote?: RemoteAgentLocation
}

export type ExternalAgentFrame =
  | { type: 'sync'; agents: ExternalAgentView[] }
  | { type: 'created' | 'updated'; agent: ExternalAgentView }
