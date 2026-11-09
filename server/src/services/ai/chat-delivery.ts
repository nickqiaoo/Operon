import type { UIMessage } from 'ai'
import { handleChat } from './chat-flow.js'
import { injectIntoChat } from './session-ops.js'
import { getChatStorage, getSessionManager } from './state.js'
import { findLatestUserMessage } from './helpers.js'
import { isChatTurnBusy, isChatTurnStarting, onChatTurnAborted, onChatTurnFinished, onChatTurnReady } from './chat-turn-lifecycle.js'

export interface ChatDelivery {
  delivery: 'injected' | 'followup' | 'started' | 'accepted' | 'unknown' | 'cancelled'
  requestId: string
  error?: string
}

/** Wait for setup/draining only. Providers own followup scheduling. */
async function waitForAdmission(chatId: number): Promise<boolean> {
  if (!isChatTurnBusy(chatId)) return true
  return new Promise<boolean>((resolve) => {
    const done = (id: number, accepted = true) => {
      if (id !== chatId) return
      unready(); unfinished(); unaborted(); resolve(accepted)
    }
    const unready = onChatTurnReady(done)
    const unfinished = onChatTurnFinished((event) => done(event.chatId))
    const unaborted = onChatTurnAborted((id) => done(id, false))
  })
}

/** Explicit host policy: active -> steer, unsupported -> followup, idle -> send.
 * Acceptance/unknown failures are never automatically resent.
 */
export async function deliverChatMessage(chatId: number, message: UIMessage, requestId = message.id,
  requestedMode: 'auto' | 'steer' | 'followup' = 'auto',
): Promise<ChatDelivery> {
  const meta = getChatStorage()?.getChatMeta(chatId)
  if (!meta) throw new Error('Conversation not found')
  for (;;) {
    if (isChatTurnStarting(chatId)) {
      if (!await waitForAdmission(chatId)) return { delivery: 'cancelled', requestId }
      continue
    }
    const session = getSessionManager().get(chatId)
    const request = session?.activeRequest
    if (request) {
      const mode = requestedMode === 'auto' ? (session.runtime.steer ? 'steer' : 'followup') : requestedMode
      if (!session.runtime[mode]) throw new Error(`Current provider does not support ${mode}`)
      const history = getChatStorage()?.getChatEntry(chatId)?.messages as UIMessage[] | undefined
      const owner = findLatestUserMessage((history ?? []).filter((item) => !(item.metadata as { steer?: boolean } | undefined)?.steer))
      const text = message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      let result = await injectIntoChat(chatId, text, owner?.id, { message, expectedRequestId: request.requestId, mode })
      let deliveredMode = mode
      if (result.delivery === 'not-sent' && requestedMode === 'auto' && mode === 'steer' && session.runtime.followup) {
        deliveredMode = 'followup'
        result = await injectIntoChat(chatId, text, owner?.id, { message, expectedRequestId: request.requestId, mode: 'followup' })
      }
      if (result.delivery !== 'not-sent') return {
        delivery: result.success ? deliveredMode === 'steer' ? 'injected' : 'followup' : result.delivery,
        requestId: request.requestId, ...(result.error ? { error: result.error } : {}),
      }
      if (requestedMode === 'auto' && isChatTurnBusy(chatId)) {
        if (!await waitForAdmission(chatId)) return { delivery: 'cancelled', requestId }
        continue
      }
      if (getSessionManager().get(chatId)?.activeRequest === request) throw new Error(result.error ?? `${mode} was not accepted`)
      continue
    }
    if (isChatTurnBusy(chatId)) {
      if (!await waitForAdmission(chatId)) return { delivery: 'cancelled', requestId }
      continue
    }
    if (requestedMode !== 'auto') throw new Error(`No active execution for ${requestedMode}`)
    const response = await handleChat({ chatId, requestId, messages: [message], providerId: meta.providerId, modelId: meta.model,
      modeId: meta.metadata?.modeId, thinkingLevel: meta.thinkingLevel, workspaceId: meta.workspaceId }, undefined, { onlyIfIdle: true })
    void response.body?.cancel().catch(() => {})
    if (response.status === 409) continue
    return { delivery: response.ok ? 'started' : 'unknown', requestId,
      ...(!response.ok ? { error: `HTTP ${response.status}; delivery unconfirmed. Do not resend automatically.` } : {}) }
  }
}
