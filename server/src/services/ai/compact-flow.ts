import { randomUUID } from 'crypto'
import type { UIMessage } from 'ai'
import type { CompactRequest } from './types.js'
import { getChatHistoryService } from './state.js'
import { startChat } from './chat-flow.js'
import { readStreamAsAsyncIterable } from '@operon/agent-runtime'
import { COMPACT_PROMPT_TEXT } from '../compact-service.js'

export async function handleCompact(
  payload: CompactRequest,
): Promise<{ success: boolean; originalMessageCount?: number; newMessageCount?: number; error?: string }> {
  const chatHistoryService = getChatHistoryService()
  if (!chatHistoryService) {
    return { success: false, error: 'Chat storage not initialized' }
  }

  const { chatId } = payload
  if (!chatId || chatId <= 0) {
    return { success: false, error: 'Invalid chatId' }
  }

  const chatEntry = chatHistoryService.getChat(chatId)
  const existingMessages = chatEntry.messages as UIMessage[]
  if (!existingMessages || existingMessages.length === 0) {
    return { success: false, error: 'No messages found in chat' }
  }
  const originalCount = existingMessages.length

  const compactUserMsg: UIMessage = {
    id: randomUUID(),
    role: 'user',
    metadata: { compactRequest: true },
    parts: [{ type: 'text', text: COMPACT_PROMPT_TEXT }],
  }

  try {
    const ctx = await startChat(
      {
        chatId,
        messages: [compactUserMsg],
        modelId: payload.modelId,
        providerId: payload.providerId ?? 'custom',
        workspaceId: payload.workspaceId,
        skipSnapshot: true,
      },
      undefined,
      { assistantMetadata: { compact: true }, skipUserMessagePersistence: true },
    )

    for await (const _ of readStreamAsAsyncIterable(ctx.preparedParts)) {
      // drain the stream so the background onFinish branch can persist the summary
    }
    await ctx.persistDone
    ctx.finish()
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Compact failed'
    console.error('[Compact] Stream run failed:', err)
    return { success: false, originalMessageCount: originalCount, error: errorMessage }
  }

  // Verify the summary landed with the compact marker
  const updatedEntry = chatHistoryService.getChat(chatId)
  const updatedMessages = updatedEntry.messages as UIMessage[]
  const last = updatedMessages[updatedMessages.length - 1]
  const marked =
    last?.role === 'assistant' &&
    (last.metadata as { compact?: boolean } | undefined)?.compact === true
  if (!marked) {
    return {
      success: false,
      originalMessageCount: originalCount,
      newMessageCount: updatedMessages.length,
      error: 'Compact assistant response missing',
    }
  }

  console.log(
    `[Compact] Chat ${chatId}: ${originalCount} → marker at index ${updatedMessages.length - 1}`,
  )

  return {
    success: true,
    originalMessageCount: originalCount,
    newMessageCount: 1,
  }
}
