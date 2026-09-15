import { randomUUID } from 'node:crypto'
import type { UIMessage } from 'ai'
import { getChatStorage, getSessionManager } from './ai/state.js'
import { handleChat } from './ai/chat-flow.js'
import { injectIntoChat } from './ai/session-ops.js'
import { isChatTurnBusy, isChatTurnStarting, onChatTurnFinished, onChatTurnReady } from './ai/chat-turn-lifecycle.js'
import { findLatestUserMessage } from './ai/helpers.js'

type Inbox = {
  pending: Map<string, UIMessage>
  flushing: boolean
  flushAgain: boolean
  timer?: ReturnType<typeof setTimeout>
}
const inboxes = new Map<number, Inbox>()
const BATCH_WINDOW_MS = 100

/** Results are durable in child history; this delivery inbox is process-local. */
export function enqueueExternalAgentResult(chatId: number, message: UIMessage): void {
  let inbox = inboxes.get(chatId)
  if (!inbox) {
    inbox = { pending: new Map(), flushing: false, flushAgain: false }
    inboxes.set(chatId, inbox)
  }
  if (!inbox.pending.has(message.id)) inbox.pending.set(message.id, message)
  schedule(chatId)
}

function schedule(chatId: number): void {
  const inbox = inboxes.get(chatId)
  if (!inbox) return
  if (inbox.flushing) { inbox.flushAgain = true; return }
  if (inbox.timer) return
  // Fixed window, not trailing debounce: a busy stream of results cannot starve delivery.
  inbox.timer = setTimeout(() => {
    inbox.timer = undefined
    void flush(chatId, inbox)
  }, BATCH_WINDOW_MS)
  inbox.timer.unref?.()
}

function batchMessage(messages: UIMessage[]): UIMessage {
  if (messages.length === 1) return messages[0]
  return {
    id: `external-results-${randomUUID()}`, role: 'user',
    parts: [{ type: 'text', text: messages.map((message) => message.parts
      .filter((part) => part.type === 'text').map((part) => part.text).join('\n')).join('\n\n') }],
    metadata: { externalAgentResults: messages.map((message) => message.metadata) },
  }
}

async function flush(chatId: number, inbox: Inbox): Promise<void> {
  if (inbox.flushing || inboxes.get(chatId) !== inbox) return
  const parent = getChatStorage()?.getChatMeta(chatId)
  if (!parent) { inboxes.delete(chatId); return }
  if (isChatTurnStarting(chatId)) return
  const session = getSessionManager().get(chatId)
  const request = session?.activeRequest
  // Also wait through stream draining/persistence after the runtime turns idle.
  if ((request && !session.runtime.injectMessage) || (!request && isChatTurnBusy(chatId))) return

  const batch = [...inbox.pending.values()]
  if (!batch.length) { inboxes.delete(chatId); return }
  const message = batchMessage(batch)
  inbox.flushing = true
  inbox.flushAgain = false
  try {
    if (request) {
      const history = getChatStorage()?.getChatEntry(chatId)?.messages as UIMessage[] | undefined
      const owner = findLatestUserMessage((history ?? []).filter((entry) =>
        !(entry.metadata as { steer?: boolean } | undefined)?.steer))
      const result = await injectIntoChat(chatId, message.parts
        .filter((part) => part.type === 'text').map((part) => part.text).join('\n'), owner?.id,
      { message, expectedRequestId: request.requestId })
      if (result.delivery === 'not-sent') {
        // Only a definite pre-injection rejection is safe to retry as a fresh turn.
        if (!isChatTurnBusy(chatId) && !getSessionManager().get(chatId)?.activeRequest) inbox.flushAgain = true
        return
      }
      if (!result.success) console.warn('[external-agent] notification injection', result.delivery, result.error)
      // Unknown provider failures must not trigger a duplicate prompt. The user
      // can still inspect the durable child result with external_agent_status.
    } else {
      const response = await handleChat({ chatId, requestId: message.id,
        messages: [message], providerId: parent.providerId, modelId: parent.model,
        modeId: parent.metadata?.modeId, thinkingLevel: parent.thinkingLevel, workspaceId: parent.workspaceId },
      undefined, { onlyIfIdle: true })
      void response.body?.cancel().catch(() => {})
      if (response.status === 409) return // A user request won startup admission.
      if (!response.ok) console.warn('[external-agent] notification turn failed', response.status)
    }
    for (const entry of batch) {
      if (inbox.pending.get(entry.id) === entry) inbox.pending.delete(entry.id)
    }
  } catch (error) {
    // Do not blindly replay a call with unknown delivery status.
    for (const entry of batch) {
      if (inbox.pending.get(entry.id) === entry) inbox.pending.delete(entry.id)
    }
    console.warn('[external-agent] notification delivery unconfirmed', error)
  } finally {
    inbox.flushing = false
    if (inboxes.get(chatId) === inbox) {
      if (!inbox.pending.size) inboxes.delete(chatId)
      else if (inbox.flushAgain) schedule(chatId)
    }
  }
}

onChatTurnReady(schedule)
onChatTurnFinished(({ chatId }) => schedule(chatId))

/** Process shutdown/test teardown: pending delivery is deliberately not replayed. */
export function clearExternalAgentNotifications(): void {
  for (const inbox of inboxes.values()) clearTimeout(inbox.timer)
  inboxes.clear()
}
