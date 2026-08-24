import type { ChatStorageAdapter } from '../storage/interface.js'
import type {
  ChatHistoryListItem,
  ChatHistoryPatchResult,
  ChatType,
} from '../types/chat.js'

const extractTitle = (messages: unknown[]): string => {
  const findText = (message: unknown) => {
    if (!message || typeof message !== 'object') return ''
    const msg = message as Record<string, unknown>
    if (typeof msg.content === 'string' && (msg.content as string).trim()) {
      return msg.content as string
    }
    const parts = msg.parts as Array<{ type: string; text?: string }> | undefined
    const partText = parts?.find((part) => part.type === 'text')?.text
    return partText ?? ''
  }

  const firstUser = messages.find(
    (m) => typeof m === 'object' && m !== null && (m as Record<string, unknown>).role === 'user'
  )
  const text = findText(firstUser) || findText(messages[0])

  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return 'Chat'
  return trimmed.slice(0, 48)
}

export class ChatHistoryService {
  constructor(private chatStorage: ChatStorageAdapter) {}

  getChat(chatId: number): { messages: unknown[]; model?: string; providerId?: string; sessionId?: string; thinkingLevel?: string; revision: number } {
    const entry = this.chatStorage.getChatEntry(chatId)
    return {
      messages: entry?.messages ?? [],
      model: entry?.model,
      providerId: entry?.providerId,
      sessionId: entry?.sessionId,
      thinkingLevel: entry?.thinkingLevel,
      revision: entry?.revision ?? 0,
    }
  }

  /** Lightweight metadata query — no messages loaded */
  getChatMeta(chatId: number) {
    return this.chatStorage.getChatMeta(chatId)
  }

  patchChat(
    chatId: number | null,
    baseRevision: number,
    replaceFrom: number,
    tailMessages: unknown[],
    tp?: ChatType,
    workspaceId?: number,
    model?: string,
    providerId?: string,
    sessionId?: string,
    thinkingLevel?: string
  ): ChatHistoryPatchResult {
    const existing = chatId !== null ? this.chatStorage.getChatMeta(chatId) : undefined

    const nextTitle = replaceFrom === 0
      ? extractTitle(tailMessages)
      : existing?.title

    return this.chatStorage.patchChatEntry(chatId, {
      baseRevision,
      replaceFrom,
      tailMessages,
      tp: tp ?? existing?.tp,
      title: nextTitle,
      workspaceId: workspaceId ?? existing?.workspaceId,
      model: model ?? existing?.model,
      providerId: providerId ?? existing?.providerId,
      sessionId: sessionId ?? existing?.sessionId,
      thinkingLevel: thinkingLevel ?? existing?.thinkingLevel,
      updatedAt: Date.now(),
      metadata: existing?.metadata,
    })
  }

  clearChat(chatId: number): boolean {
    this.chatStorage.deleteChatEntry(chatId)
    return true
  }

  listChats(
    workspaceId?: number,
    tp?: string,
    paging?: { limit?: number; offset?: number },
  ): ChatHistoryListItem[] {
    return this.chatStorage.listChatEntries({
      workspaceId,
      tp,
      limit: paging?.limit,
      offset: paging?.offset,
    })
  }
}
