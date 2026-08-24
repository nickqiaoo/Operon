/**
 * AgentMessageSurface — agent-facing workspace chat abstraction.
 *
 * This surface is intentionally chat-only. Project task coordination lives in
 * TaskBoardService so message transport and work tracking do not share tool
 * names or lifecycle rules.
 */

export interface BridgeChannel {
  name: string
  description: string
  joined: boolean
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

export interface UploadResult {
  attachmentId: string
  filename: string
  sizeBytes: number
}

export interface ViewFileResult {
  filePath: string
}

export interface AgentMessageSurface {
  /** Send a message to a channel or thread. Returns the short message id. */
  sendMessage(params: {
    target: string            // '#channel' | '#channel:shortId' | 'dm:@name'
    content: string
    agentId: number
    attachmentIds?: string[]
  }): Promise<{ messageId: string }>

  /**
   * Non-blocking check for unread messages across all channels the agent belongs to.
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
  listServer(): Promise<{ channels: BridgeChannel[]; agents: BridgeAgent[]; humans: BridgeHuman[] }>

  /** Upload a local file and return an attachment id + metadata. */
  uploadFile(filePath: string, channel: string): Promise<UploadResult>

  /** Resolve an attachment id to its local file path. */
  viewFile(attachmentId: string): Promise<ViewFileResult>
}
