// Wire DTOs for teams / peers. Mirrors server/src/services/operon-runtime/peers.ts + peers-config.ts.

export type PeerMemberStatus = 'running' | 'idle' | 'parked' | 'error'

export interface PeerMemberDTO {
  name: string
  type: string
  typeTitle: string
  description?: string
  status: PeerMemberStatus
  sessionId: string
  /** The chat row that is this teammate's transcript (absent only if creation failed). */
  chatId?: number
  updatedAt: number
  pendingApprovals: number
}

export interface PeerTeamDTO {
  label: string
  name: string
  creatorSessionId: string
  leadChatId?: number
  leadStatus?: PeerMemberStatus
  members: PeerMemberDTO[]
}

export interface PeerCountersDTO {
  messagesSent: number
  messagesReceived: number
  wakes: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cost: number
}

export interface PeersBudgetDTO {
  maxWakes?: number
  maxTotalTokens?: number
}

/** One line of the fleet's spend, named. Mirrors the node's `PeerAgentStatsDTO`. */
export interface PeerAgentStatsDTO extends PeerCountersDTO {
  agentId: string
  /** A teammate's name, the lead's chat title, or the raw id. */
  label: string
  /** `other` = a conversation that mounted the hub but is in no team. */
  kind: 'member' | 'lead' | 'other'
}

export interface PeersStatsDTO {
  totals: PeerCountersDTO
  /** The totals, split by who spent it. Descending by `totalTokens`. */
  agents: PeerAgentStatsDTO[]
  budget: PeersBudgetDTO
  /** Why peer traffic is paused, when the budget is exhausted. */
  exceeded?: string
}

export interface PeersRosterDTO {
  /** The Teams extension is loaded and its network is up. */
  available: boolean
  teams: PeerTeamDTO[]
  stats: PeersStatsDTO | null
  types: Array<{ id: string; title: string; description?: string }>
}

export interface TeammateTypeConfig {
  title: string
  description?: string
  modelId?: string
  modeId?: string
  instructions?: string
}

export interface PeersConfig {
  budget: PeersBudgetDTO
  types: Record<string, TeammateTypeConfig>
}
