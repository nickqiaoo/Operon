export type ChatType = 'chat' | 'canvas' | 'cronjob' | 'subagent' | 'linear'

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
  /** Runtime option selections (thinkingLevel, mode, etc.) bound to this chat
   * at first start so reloading from history restores the same selections.
   * Mid-conversation changes are not allowed — provider/model/runtimeOptions
   * are locked once a chat is bound. */
  chatRuntimeOptions?: Record<string, string>
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
