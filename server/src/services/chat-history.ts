import type { ChatStorageAdapter } from '../storage/interface.js'
import type {
  ChatHistoryListItem,
  CreateChatInput,
  PutChatMessageInput,
  PutChatMessageResult,
} from '../types/chat.js'

// Mirrors `parseContextBlocks` in src/lib/context-blocks.ts: quoted context
// (selected text, line comments…) is sent ahead of the prompt as
// `[File: name]\n…\n[/File]` blocks, and the title should come from the prompt.
const stripContextBlocks = (text: string): string =>
  text.replace(/^(?:\[File: [^\]\n]+\]\n[\s\S]*?\n\[\/File\]\n*)+/, '')

export const extractTitle = (messages: readonly unknown[]): string => {
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

  const trimmed = (stripContextBlocks(text) || text).replace(/\s+/g, ' ').trim()
  if (!trimmed) return 'Chat'
  return trimmed.slice(0, 48)
}

export class ChatHistoryService {
  constructor(private chatStorage: ChatStorageAdapter) {}

  getChat(chatId: number): { messages: unknown[]; model?: string; providerId?: string; sessionId?: string; thinkingLevel?: string } {
    const entry = this.chatStorage.getChatEntry(chatId)
    return {
      messages: entry?.messages ?? [],
      model: entry?.model,
      providerId: entry?.providerId,
      sessionId: entry?.sessionId,
      thinkingLevel: entry?.thinkingLevel,
    }
  }

  /** Lightweight metadata query — no messages loaded */
  getChatMeta(chatId: number) {
    return this.chatStorage.getChatMeta(chatId)
  }

  /** Create a chat; without a title it is named after its first user message. */
  createChat(input: Omit<CreateChatInput, 'title' | 'updatedAt'> & { title?: string }): number {
    return this.chatStorage.createChat({
      ...input,
      title: input.title?.trim() || extractTitle(input.messages ?? []),
      updatedAt: Date.now(),
    })
  }

  /**
   * Add or replace one message by id; see `PutChatMessageInput`. Stamps the
   * chat's `updated_at`. Undefined when the chat does not exist.
   */
  putMessage(chatId: number, input: Omit<PutChatMessageInput, 'updatedAt'>): PutChatMessageResult | undefined {
    return this.chatStorage.putChatMessage(chatId, { ...input, updatedAt: Date.now() })
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
