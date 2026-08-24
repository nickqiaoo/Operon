import type { UIMessage } from 'ai'
import type { AiChatRequest, ChatRecordState } from './types.js'
import { getChatStorage, getChatHistoryService } from './state.js'
import { findLatestUserMessage } from './helpers.js'

export const prepareChatRecord = (
  payload: AiChatRequest,
  normalizedMessages: UIMessage[]
): ChatRecordState => {
  const chatHistoryService = getChatHistoryService()
  if (!chatHistoryService) {
    return {
      chatId: payload.chatId ?? 0,
      baseRevision: 0,
    }
  }

  const lastUserMessage = findLatestUserMessage(normalizedMessages)
  if (!lastUserMessage) {
    throw new Error('Cannot create a new chat without a user message')
  }
  let chatId = payload.chatId ?? 0

  if (chatId > 0) {
    const meta = chatHistoryService.getChatMeta(chatId)
    if (meta) {
      // A single user turn can hit /api/ai/chat multiple times (tool-approval
      // round-trips, sendAutomaticallyWhen continuations). Each re-send carries
      // the same last user message, and appending (replaceFrom -1) every time
      // stored it twice at consecutive indices. Skip if it's already persisted.
      const existing = (chatHistoryService.getChat(chatId)?.messages ?? []) as UIMessage[]
      if (existing.some((m) => m.id === lastUserMessage.id)) {
        return { chatId, baseRevision: meta.revision, sessionId: meta.sessionId }
      }
      const saveResult = chatHistoryService.patchChat(
        chatId,
        meta.revision,
        -1,
        [lastUserMessage],
        payload.tp ?? 'chat',
        payload.workspaceId,
        payload.modelId,
        payload.providerId,
        undefined,
        payload.thinkingLevel
      )
      if (!saveResult.success) {
        throw new Error(`Chat history conflict while appending user message (chatId=${chatId}, revision=${saveResult.revision})`)
      }
      return {
        chatId,
        baseRevision: saveResult.revision,
        sessionId: meta.sessionId,
      }
    }

    return {
      chatId,
      baseRevision: 0,
    }
  }

  const createResult = chatHistoryService.patchChat(
    null,
    0,
    0,
    [lastUserMessage],
    payload.tp ?? 'chat',
    payload.workspaceId,
    payload.modelId,
    payload.providerId,
    undefined,
    payload.thinkingLevel
  )
  if (!createResult.success) {
    throw new Error('Failed to create chat history before starting chat')
  }

  chatId = createResult.chatId
  return {
    chatId,
    baseRevision: createResult.revision,
  }
}

export const persistSessionId = (chatId: number, sessionIdRef: { value?: string }, sessionId: string): void => {
  if (sessionId === sessionIdRef.value) return
  sessionIdRef.value = sessionId
  const chatStorage = getChatStorage()
  if (chatStorage && chatId > 0) {
    chatStorage.updateChatSessionId(chatId, sessionId)
  }
}

export const persistInjectedUserMessageWithRetry = (
  chatId: number,
  userMessage: UIMessage
): { success: boolean; error?: string } => {
  const chatHistoryService = getChatHistoryService()
  if (!chatHistoryService || chatId <= 0) {
    return { success: true }
  }

  const initialMeta = chatHistoryService.getChatMeta(chatId)
  if (!initialMeta) {
    return { success: false, error: 'Chat history not found' }
  }

  const initialResult = chatHistoryService.patchChat(
    chatId,
    initialMeta.revision,
    -1,
    [userMessage],
    initialMeta.tp,
    initialMeta.workspaceId,
    initialMeta.model,
    initialMeta.providerId,
    initialMeta.sessionId,
    initialMeta.thinkingLevel
  )

  if (initialResult.success) {
    return { success: true }
  }

  const latestMeta = chatHistoryService.getChatMeta(chatId)
  if (!latestMeta) {
    return { success: false, error: 'Chat history not found' }
  }

  const retryResult = chatHistoryService.patchChat(
    chatId,
    latestMeta.revision,
    -1,
    [userMessage],
    latestMeta.tp,
    latestMeta.workspaceId,
    latestMeta.model,
    latestMeta.providerId,
    latestMeta.sessionId,
    latestMeta.thinkingLevel
  )

  if (!retryResult.success) {
    return { success: false, error: 'Failed to persist steer message' }
  }

  return { success: true }
}

export async function persistAssistantMessageWithRetry(params: {
  chatId: number
  baseRevision: number
  assistantMessage: UIMessage
  replaceFrom?: number
  modelId?: string
  providerId?: string
  sessionId?: string
}): Promise<void> {
  const chatHistoryService = getChatHistoryService()
  if (!chatHistoryService || params.chatId <= 0) return

  const initialResult = chatHistoryService.patchChat(
    params.chatId,
    params.baseRevision,
    params.replaceFrom ?? -1,
    [params.assistantMessage],
    undefined,
    undefined,
    params.modelId,
    params.providerId,
    params.sessionId
  )

  if (initialResult.success) return

  const latestMeta = chatHistoryService.getChatMeta(params.chatId)
  if (!latestMeta) {
    console.error('[AI] Assistant persistence conflict and chat metadata missing:', {
      chatId: params.chatId,
      baseRevision: params.baseRevision,
      conflictRevision: initialResult.revision,
    })
    return
  }

  const retryResult = chatHistoryService.patchChat(
    params.chatId,
    latestMeta.revision,
    params.replaceFrom ?? -1,
    [params.assistantMessage],
    undefined,
    undefined,
    params.modelId,
    params.providerId,
    params.sessionId
  )

  if (!retryResult.success) {
    console.error('[AI] Assistant persistence conflict after retry:', {
      chatId: params.chatId,
      initialBaseRevision: params.baseRevision,
      initialConflictRevision: initialResult.revision,
      retryBaseRevision: latestMeta.revision,
      retryConflictRevision: retryResult.revision,
    })
  }
}

export const hasPersistableAssistantMessage = (message: UIMessage): boolean =>
  message.parts.length > 0 || message.metadata != null

export const mergeAssistantMetadata = (
  message: UIMessage,
  metadata?: Record<string, unknown>,
): UIMessage => {
  if (!metadata) return message
  return {
    ...message,
    metadata: { ...(message.metadata ?? {}), ...metadata },
  }
}
