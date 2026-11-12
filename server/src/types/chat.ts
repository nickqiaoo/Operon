export type ChatType = 'chat' | 'canvas' | 'cronjob' | 'subagent' | 'linear' | 'side' | 'teammate' | 'workflow-agent'

export interface ChatMetadata {
  /** An independent, server-owned external-agent conversation (not a fork). */
  externalAgent?: import('../../../shared/external-agent.js').ExternalAgentBinding
  /** canvas chat fields */
  workflowId?: number
  runId?: number
  nodeId?: string
  nodeName?: string
  /** cronjob chat fields */
  cronjobId?: number
  /** chat-runtime fields */
  modeId?: string
  /** A workflow or spec sub-agent's conversation (tp 'workflow-agent'): which run row it is. */
  workflowAgent?: {
    runId: string
    index: number
    /** The conversation that launched the run, if any. */
    parentChatId: number | null
    /** Where it ran — a disposable worktree, usually; used while it still exists. */
    cwd: string
  }
  /**
   * The hidden row standing for the personal assistant as a spec's source chat. A
   * spec needs a chat to report to; the assistant's thread is not one, and one row
   * per spec lets it run several at once. Holds no messages and never runs a turn:
   * notices are handed to the assistant (workflow/completion.ts).
   */
  assistantSpec?: { projectId: number }
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
  /** The workspace the chat belongs to; null for one outside any workspace. */
  workspaceId?: number | null
}

/** Lightweight chat metadata (no messages loaded) */
export interface ChatMeta {
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

/** A transcript message as stored: a `UIMessage`, or anything shaped like one. */
export interface StoredChatMessage {
  id: string
  parts: readonly unknown[]
}

/** Chat-row fields a write may set. Fields left undefined keep their current value. */
export interface ChatConfigPatch {
  tp?: ChatType
  workspaceId?: number
  model?: string
  providerId?: string
  sessionId?: string
  thinkingLevel?: string
}

export interface CreateChatInput extends ChatConfigPatch {
  tp: ChatType
  title: string
  metadata?: ChatMetadata
  /** Stored in this order. */
  messages?: readonly StoredChatMessage[]
  updatedAt: number
}

/**
 * Write one message by its id: replace it when the chat already has a message
 * with that id, otherwise add it at the end.
 */
export interface PutChatMessageInput {
  message: StoredChatMessage
  /**
   * The parts that changed since this message was last written; the others are
   * stored as they are. Omitted: every part. Stored parts past the end of
   * `message.parts` are removed either way.
   */
  partIndices?: Iterable<number>
  /**
   * A new message goes ahead of this one when it is the chat's last message —
   * a steer filed ahead of the reply being written. Otherwise at the end.
   */
  before?: string
  /** Keep the stored message when the chat already has one with this id. */
  ifAbsent?: boolean
  chat?: ChatConfigPatch
  /** The chat's new `updated_at`; omitted, it is left as it is. */
  updatedAt?: number
}

/** `bytes`: what this write stored, so a caller writing often can pace itself. */
export type PutChatMessageResult = { written: boolean; bytes: number }
