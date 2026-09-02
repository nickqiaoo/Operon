export type ChatType = 'chat' | 'canvas' | 'cronjob' | 'subagent' | 'linear' | 'side' | 'teammate'

export interface ChatMetadata {
  /** canvas chat fields */
  workflowId?: number
  runId?: number
  nodeId?: string
  nodeName?: string
  /** cronjob chat fields */
  cronjobId?: number
  /** chat-runtime fields */
  modeId?: string
  /** linear agent chat fields */
  source?: 'linear'
  linearSessionId?: string
  linearOrgId?: string
  linearIssueId?: string
  /** side chat fields — a temporary branch of `parentChatId`'s conversation.
   *  The runtime forks the parent's provider session on the first turn, so the
   *  model inherits the parent's history while this chat opens empty. The two
   *  diverge from that point on and are never merged back. */
  parentChatId?: number
  /** How far the parent had got when this branched, for the "forked at #N" label. */
  forkedAtMessageIndex?: number
  /** Runtime option selections (thinkingLevel, mode, etc.) bound to this chat
   * at first start so reloading from history restores the same selections.
   * Mid-conversation changes are not allowed — provider/model/runtimeOptions
   * are locked once a chat is bound. */
  chatRuntimeOptions?: Record<string, string>
  /** teammate chat fields — a peer session spawned by a lead's `Team spawn`.
   *  The chat row is the transcript of that independent session; its
   *  `sessionId` column points at the teammate's harness session. */
  peer?: {
    /** Roster name (what teammates address it by). */
    name: string
    /** Full team label, `team:<creatorSessionId>:<teamName>`. */
    team: string
    /** Teammate type (`coder`, `reviewer`, …) — the host-defined birth config. */
    type: string
    /** The session that spawned it (= the lead's harness session id). */
    creatorSessionId: string
    /** The lead's chat, when one exists for that session. */
    leadChatId?: number
  }
}

export interface ChatHistoryEntry {
  messages: unknown[]
  tp: ChatType
  title?: string
  workspaceId?: number
  model?: string
  providerId?: string
  sessionId?: string
  thinkingLevel?: string
  updatedAt: number
  metadata?: ChatMetadata
  revision?: number
}

export interface ChatHistoryStore {
  chats: Record<number, ChatHistoryEntry>
}

export interface ChatHistoryListItem {
  id: number
  tp: ChatType
  title: string
  updatedAt: number
  model?: string
  providerId?: string
  sessionId?: string
  thinkingLevel?: string
  metadata?: ChatMetadata
}

/** Lightweight chat metadata (no messages loaded) */
export interface ChatMeta {
  revision: number
  tp: ChatType
  title?: string
  workspaceId?: number
  model?: string
  providerId?: string
  sessionId?: string
  thinkingLevel?: string
  updatedAt: number
  metadata?: ChatMetadata
}

export interface ChatHistoryPatchInput {
  baseRevision: number
  replaceFrom: number
  tailMessages: unknown[]
  tp?: ChatType
  title?: string
  workspaceId?: number
  model?: string
  providerId?: string
  sessionId?: string
  thinkingLevel?: string
  updatedAt: number
  metadata?: ChatMetadata
}

export type ChatHistoryPatchResult =
  | {
    success: true
    chatId: number
    revision: number
  }
  | {
    success: false
    conflict: true
    revision: number
  }
