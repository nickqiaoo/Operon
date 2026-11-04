import type { UIMessage } from 'ai'
import type { AiChatRequest, ChatRecordState } from './types.js'
import type { ChatMetadata } from '../../types/chat.js'
import { getChatStorage, getChatHistoryService } from './state.js'
import { findLatestUserMessage } from './helpers.js'

/**
 * Remember the permission mode the person last sent with. The composer holds it
 * client-side and sends it on every turn, but turns the server starts on the
 * chat's behalf (a workflow reporting back, an external agent's result, an IM
 * reply) only have the chat row to go on — without this they fell back to the
 * provider's default mode, e.g. stopping for approvals in a Full Access chat.
 */
const persistModeId = (chatId: number, modeId: string | undefined, metadata: ChatMetadata | undefined): void => {
  if (!modeId || chatId <= 0 || metadata?.modeId === modeId) return
  getChatStorage()?.updateChatMetadata(chatId, { ...metadata, modeId })
}

export const prepareChatRecord = (
  payload: AiChatRequest,
  normalizedMessages: UIMessage[]
): ChatRecordState => {
  const chatHistoryService = getChatHistoryService()
  if (!chatHistoryService) {
    return { chatId: payload.chatId ?? 0 }
  }

  const lastUserMessage = findLatestUserMessage(normalizedMessages)
  if (!lastUserMessage) {
    throw new Error('Cannot create a new chat without a user message')
  }
  const chatId = payload.chatId ?? 0

  if (chatId > 0) {
    const meta = chatHistoryService.getChatMeta(chatId)
    if (!meta) return { chatId }
    // A single user turn can hit /api/ai/chat several times (tool-approval
    // round-trips, sendAutomaticallyWhen continuations), each carrying the same
    // last user message: store it once.
    const result = chatHistoryService.putMessage(chatId, {
      message: lastUserMessage,
      ifAbsent: true,
      // No `?? 'chat'` for tp: an existing row already knows what it is, and
      // the send payload does not carry `tp`. Defaulting would rewrite a side
      // chat into a plain chat on its first message.
      chat: {
        tp: payload.tp,
        workspaceId: payload.workspaceId,
        model: payload.modelId,
        providerId: payload.providerId,
        thinkingLevel: payload.thinkingLevel,
      },
    })
    if (!result) {
      throw new Error(`Chat history not found while appending user message (chatId=${chatId})`)
    }
    if (result.written) persistModeId(chatId, payload.modeId, meta.metadata)
    return { chatId, sessionId: meta.sessionId }
  }

  const createdId = chatHistoryService.createChat({
    tp: payload.tp ?? 'chat',
    workspaceId: payload.workspaceId,
    model: payload.modelId,
    providerId: payload.providerId,
    thinkingLevel: payload.thinkingLevel,
    messages: [lastUserMessage],
  })
  persistModeId(createdId, payload.modeId, undefined)
  return { chatId: createdId }
}

export const persistSessionId = (chatId: number, sessionIdRef: { value?: string }, sessionId: string): void => {
  if (sessionId === sessionIdRef.value) return
  sessionIdRef.value = sessionId
  const chatStorage = getChatStorage()
  if (chatStorage && chatId > 0) {
    chatStorage.updateChatSessionId(chatId, sessionId)
  }
}

/**
 * The replies being written on each chat, oldest first. A turn saves its reply
 * as it goes (see `runAgentTurn`'s `onCheckpoint`), so while it runs the reply
 * already sits in the transcript — partly written. Anything that reads the
 * transcript and cares about that (a steer filed before it, memory extraction
 * waiting for it to settle) asks here. A list, not one slot: a detached turn can
 * start while another is still finishing, and the one that ends first must not
 * clear the other.
 */
const runningAssistantMessages = new Map<number, string[]>()

export const beginAssistantMessage = (chatId: number, messageId: string): void => {
  if (chatId <= 0) return
  const running = runningAssistantMessages.get(chatId) ?? []
  runningAssistantMessages.set(chatId, [...running.filter((id) => id !== messageId), messageId])
}

export const endAssistantMessage = (chatId: number, messageId: string): void => {
  const running = runningAssistantMessages.get(chatId)?.filter((id) => id !== messageId)
  if (running?.length) runningAssistantMessages.set(chatId, running)
  else runningAssistantMessages.delete(chatId)
}

/** True while a turn on `chatId` is still writing its reply. */
export const isAssistantMessageRunning = (chatId: number): boolean => runningAssistantMessages.has(chatId)

/**
 * Save a steer. It goes in ahead of the reply the running turn has saved so far,
 * which keeps the order the transcript had before replies were saved mid-turn:
 * the prompt, its steers, then the reply.
 */
export const persistInjectedUserMessage = (
  chatId: number,
  userMessage: UIMessage
): { success: boolean; error?: string } => {
  const chatHistoryService = getChatHistoryService()
  if (!chatHistoryService || chatId <= 0) {
    return { success: true }
  }
  const result = chatHistoryService.putMessage(chatId, {
    message: userMessage,
    before: runningAssistantMessages.get(chatId)?.at(-1),
  })
  return result ? { success: true } : { success: false, error: 'Chat history not found' }
}

/**
 * A part that will not change again in this turn. Once one is stored it is not
 * written again: a long reply is mostly finished tool calls, and rewriting them
 * on every checkpoint is what made saving a reply cost its whole size each time.
 * Anything not known to be final (data parts, which can be replaced by id; an
 * open text block; a tool waiting on approval) is rewritten on every save.
 */
export const isSettledPart = (part: UIMessage['parts'][number]): boolean => {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return part.state === 'done'
    case 'step-start':
    case 'source-url':
    case 'source-document':
    case 'file':
      return true
    case 'dynamic-tool':
      break
    default:
      if (!part.type.startsWith('tool-')) return false
  }
  const tool = part as { state?: string; preliminary?: boolean }
  return (tool.state === 'output-available' && tool.preliminary !== true)
    || tool.state === 'output-error'
    || tool.state === 'output-denied'
}

export interface ReplyWriter {
  /** Save the reply as it stands: its first save adds it, later ones update it in place. */
  save(message: UIMessage, sessionId?: string): { saved: true; bytes: number } | { saved: false }
}

/**
 * Saves one turn's reply, as often as asked, writing only the parts that
 * changed: every part this writer has not yet stored in its final form. The
 * first save writes every part, so a continuation (which picks up an assistant
 * message the client sent back) leaves the stored copy exactly as assembled.
 * `bytes` is what a save wrote, for pacing the next checkpoint.
 */
export function createReplyWriter(params: {
  chatId: number
  modelId?: string
  providerId?: string
  assistantMetadata?: Record<string, unknown>
}): ReplyWriter {
  const stored = new Set<number>()

  return {
    save(message, sessionId) {
      const chatHistoryService = getChatHistoryService()
      if (!chatHistoryService || params.chatId <= 0) return { saved: false }
      const toSave = mergeAssistantMetadata(message, params.assistantMetadata)
      for (const i of stored) if (i >= toSave.parts.length) stored.delete(i)
      const changed = [...toSave.parts.keys()].filter((i) => !stored.has(i))
      const result = chatHistoryService.putMessage(params.chatId, {
        message: toSave,
        partIndices: changed,
        chat: { model: params.modelId, providerId: params.providerId, sessionId },
      })
      if (!result) {
        console.error('[AI] Assistant persistence failed: chat not found', { chatId: params.chatId })
        return { saved: false }
      }
      for (const i of changed) if (isSettledPart(toSave.parts[i])) stored.add(i)
      return { saved: true, bytes: result.bytes }
    },
  }
}

/**
 * Gap before the next checkpoint after one that wrote `bytes`. A checkpoint
 * writes only what changed, but a burst of large tool output still costs that
 * much, so it waits longer: 1s, plus 1s per MB, at most 10s.
 */
export const checkpointGapMs = (bytes: number): number =>
  Math.min(10_000, 1_000 + Math.floor(bytes / 1_000_000) * 1_000)

export const hasPersistableAssistantMessage = (message: UIMessage): boolean =>
  message.parts.length > 0 || message.metadata != null

/** A mid-turn snapshot worth saving: it has said or done something. */
export const hasCheckpointContent = (message: UIMessage): boolean =>
  message.parts.some((part) => part.type !== 'step-start')

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
