import type { UIMessage } from 'ai'
import type { AiChatRequest } from './types.js'

export interface ChatTurnFinished {
  chatId: number
  turnId: string
  status: 'completed' | 'cancelled' | 'failed'
  message?: UIMessage
  prompt?: UIMessage
  error?: string
}

// Observation and startup admission only. No promises wait for a model turn.
const turns = new Map<number, Map<string, 'starting' | 'running'>>()
const listeners = new Set<(event: ChatTurnFinished) => void>()
const startListeners = new Set<(payload: AiChatRequest) => void>()
const readyListeners = new Set<(chatId: number) => void>()
const abortListeners = new Set<(chatId: number) => void>()
const aborters = new Map<number, () => void>()

/** Reserve setup synchronously, before the first await in handleChat. */
export function beginChatTurn(chatId: number, turnId: string, onlyIfIdle = false): boolean {
  if (isChatTurnStarting(chatId) || (onlyIfIdle && isChatTurnBusy(chatId))) return false
  const active = turns.get(chatId) ?? new Map<string, 'starting' | 'running'>()
  active.set(turnId, 'starting')
  turns.set(chatId, active)
  return true
}

export function markChatTurnReady(chatId: number, turnId: string): void {
  const active = turns.get(chatId)
  if (!active?.has(turnId)) return
  active.set(turnId, 'running')
  for (const listener of readyListeners) {
    try { listener(chatId) } catch (error) { console.warn('[chat-turn] ready observer failed', error) }
  }
}

export function registerChatTurnAbort(chatId: number, abort: () => void): () => void {
  aborters.set(chatId, abort)
  return () => { if (aborters.get(chatId) === abort) aborters.delete(chatId) }
}

/** Also covers provider setup, before SessionManager has an active request. */
export function abortManagedChatTurn(chatId: number): boolean {
  for (const listener of abortListeners) {
    try { listener(chatId) } catch (error) { console.warn('[chat-turn] abort observer failed', error) }
  }
  const abort = aborters.get(chatId)
  abort?.()
  return abort !== undefined
}

export function isChatTurnBusy(chatId: number): boolean {
  return turns.has(chatId)
}

export function isChatTurnStarting(chatId: number): boolean {
  return [...(turns.get(chatId)?.values() ?? [])].includes('starting')
}

export function onChatTurnReady(listener: (chatId: number) => void): () => void {
  readyListeners.add(listener)
  return () => { readyListeners.delete(listener) }
}

export function onChatTurnAborted(listener: (chatId: number) => void): () => void {
  abortListeners.add(listener)
  return () => { abortListeners.delete(listener) }
}

export function onChatTurnFinished(listener: (event: ChatTurnFinished) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function onChatTurnStarted(listener: (payload: AiChatRequest) => void): () => void {
  startListeners.add(listener)
  return () => { startListeners.delete(listener) }
}

export function emitChatTurnStarted(payload: AiChatRequest): void {
  for (const listener of startListeners) {
    try { listener(payload) } catch (error) { console.warn('[chat-turn] start observer failed', error) }
  }
}

export function emitChatTurnFinished(event: ChatTurnFinished): void {
  const active = turns.get(event.chatId)
  active?.delete(event.turnId)
  if (active?.size === 0) turns.delete(event.chatId)
  for (const listener of listeners) {
    try { listener(event) } catch (error) { console.warn('[chat-turn] finish observer failed', error) }
  }
}

/**
 * Resolves once this chat has no turn in flight.
 *
 * `emitChatTurnFinished` fires only after `persistDone` has settled, so "idle"
 * here means the turn's assistant message is already in the database. That is
 * exactly the guarantee a client needs before it reconciles its transcript
 * against chat history: reconciling earlier reads a tail that is missing the
 * reply still being written, and the client then "corrects" a correct
 * transcript by deleting it.
 *
 * Best-effort: a runtime that never honours the abort would otherwise hang the
 * caller, so the wait gives up after `timeoutMs` and resolves anyway.
 */
export function waitForChatTurnIdle(chatId: number, timeoutMs = 5000): Promise<void> {
  if (!isChatTurnBusy(chatId)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const settle = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const timer = setTimeout(settle, timeoutMs)
    const unsubscribe = onChatTurnFinished((event) => {
      if (event.chatId !== chatId) return
      if (!isChatTurnBusy(chatId)) settle()
    })
    // The turn may have ended between the check above and the subscription.
    if (!isChatTurnBusy(chatId)) settle()
  })
}
