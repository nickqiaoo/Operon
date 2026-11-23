/**
 * AgentMessageSurface — agent-facing workspace chat abstraction.
 *
 * This surface is intentionally chat-only. Project task coordination lives in
 * TaskBoardService so message transport and work tracking do not share tool
 * names or lifecycle rules.
 */

/** A channel the agent is a member of, with who else is in it. */
export interface BridgeChannel {
  name: string
  description: string
  members: BridgeAgent[]
}

export interface BridgeAgent {
  name: string
  status: string
}

export interface BridgeHuman {
  name: string
}

export interface HistoryMessage {
  seq: number
  formatted: string
}

export interface ReadHistoryResult {
  messages: HistoryMessage[]
  hasMore: boolean
  lastReadSeq: number
}

/**
 * `held`: nothing was posted — messages the sender had not seen arrived first.
 * `pending` holds them (formatted, now marked read); the agent may resend with
 * `force` if its message still adds something.
 */
export type SendMessageResult =
  | { status: 'sent'; messageId: string }
  | { status: 'held'; pending: string[] }

export interface AgentMessageSurface {
  /** Send a message to a channel or thread. Returns the short message id, or the messages that held it. */
  sendMessage(params: {
    target: string            // '#channel' | '#channel:shortId' | 'dm:@name'
    content: string
    agentId: number
    /** Absolute paths of local image files to attach; copied into the attachment store. */
    images?: string[]
    /** Skip the unseen-messages hold (resend after a `held` result). */
    force?: boolean
  }): Promise<SendMessageResult>

  /**
   * Non-blocking check for unread messages in the calling session's channel
   * (every channel the agent belongs to, for a caller with no session channel).
   * Updates the read cursor before returning (at-most-once delivery).
   * Returns formatted message lines, or an empty array if nothing is new.
   */
  checkMessages(agentId: number): Promise<string[]>

  /** Read paginated history for a channel/thread/DM. Returns structured result for formatting. */
  readHistory(params: {
    channel: string
    limit: number
    before?: number
    after?: number
    agentId?: number
  }): Promise<ReadHistoryResult>

  /** List all channels, agents, and humans visible to the agent. */
  /** The channels the agent is a member of, their members, and the humans. */
  listServer(agentId: number): Promise<{ channels: BridgeChannel[]; humans: BridgeHuman[] }>
}
