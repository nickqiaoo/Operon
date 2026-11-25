// The chat turn registry: the one place that knows whether a chat has a turn,
// from the moment it is admitted (before its provider has even started) until
// its reply is saved. Everything that asks "is this chat busy?" asks here —
// admission, waiting for idle, the status every surface shows — and each turn's
// reply stream is registered with it, so attaching to "the chat's turn" finds
// the same turn the status announced.

import type { UIMessage } from 'ai'
import type { AiChatRequest } from './types.js'
import type { TurnStream } from './turn-stream.js'

export interface ChatTurnFinished {
  chatId: number
  turnId: string
  status: 'completed' | 'cancelled' | 'failed'
  message?: UIMessage
  prompt?: UIMessage
  error?: string
}

/** Whether a chat has a turn, as every surface is told it. */
export interface ChatTurnStatus {
  chatId: number
  active: boolean
  /** The chat's newest turn while one is admitted. */
  turnId: string | null
  startedAt: number | null
}

/**
 * How a new turn treats a chat whose previous turn is still starting: `force`
 * runs anyway (server work that must not be dropped), `reject` refuses it, and
 * `idle-only` also refuses one whose turn is running (a background notice must
 * never preempt a person).
 */
export type ChatTurnAdmission = 'force' | 'reject' | 'idle-only'

interface TurnRecord {
  phase: 'starting' | 'running'
  startedAt: number
  /** Its reply, for surfaces to attach to. Absent for a turn kept off screen. */
  stream?: TurnStream
}

/** A finished turn's stream stays attachable this long. History has the reply by then. */
const FINISHED_STREAM_GRACE_MS = 30_000

/** Turns admitted per chat, oldest first (a new turn can start while a preempted one winds down). */
const turns = new Map<number, Map<string, TurnRecord>>()
/** The stream of each chat's last finished turn, while a client that blinked out may still want its end. */
const finishedStreams = new Map<number, { stream: TurnStream; timer: ReturnType<typeof setTimeout> }>()

const finishListeners = new Set<(event: ChatTurnFinished) => void>()
const startListeners = new Set<(payload: AiChatRequest) => void>()
const readyListeners = new Set<(chatId: number) => void>()
const abortListeners = new Set<(chatId: number) => void>()
const statusListeners = new Set<(status: ChatTurnStatus) => void>()
const aborters = new Map<number, () => void>()

function newestTurn(chatId: number): [string, TurnRecord] | undefined {
  const active = turns.get(chatId)
  if (!active || active.size === 0) return undefined
  let last: [string, TurnRecord] | undefined
  for (const entry of active) last = entry
  return last
}

export function getChatTurnStatus(chatId: number): ChatTurnStatus {
  const newest = newestTurn(chatId)
  return {
    chatId,
    active: newest !== undefined,
    turnId: newest?.[0] ?? null,
    startedAt: newest?.[1].startedAt ?? null,
  }
}

/** Every chat with a turn admitted — the status stream's connect-time snapshot. */
export function listActiveChatTurns(): ChatTurnStatus[] {
  return [...turns.keys()].map(getChatTurnStatus)
}

/** Told every time any chat's status changes. */
export function onChatTurnStatus(listener: (status: ChatTurnStatus) => void): () => void {
  statusListeners.add(listener)
  return () => { statusListeners.delete(listener) }
}

function emitStatus(chatId: number): void {
  const status = getChatTurnStatus(chatId)
  for (const listener of statusListeners) {
    try { listener(status) } catch (error) { console.warn('[chat-turn] status observer failed', error) }
  }
}

/**
 * The stream a surface attaches to for this chat: its newest turn's, or the
 * one that just finished.
 */
export function getChatTurnStream(chatId: number): TurnStream | undefined {
  const newest = newestTurn(chatId)
  if (newest) return newest[1].stream
  return finishedStreams.get(chatId)?.stream
}

/**
 * Admit a turn and announce it. Synchronous, so admission and setup
 * reservation happen together, before any asynchronous provider work. Returns
 * false when `admission` refuses it (nothing is registered then).
 */
export function beginChatTurn(
  chatId: number,
  turnId: string,
  options: { admission?: ChatTurnAdmission; stream?: TurnStream } = {},
): boolean {
  const admission = options.admission ?? 'reject'
  if (admission !== 'force' && (isChatTurnStarting(chatId) || (admission === 'idle-only' && isChatTurnBusy(chatId)))) {
    return false
  }
  const active = turns.get(chatId) ?? new Map<string, TurnRecord>()
  active.set(turnId, { phase: 'starting', startedAt: Date.now(), stream: options.stream })
  turns.set(chatId, active)
  emitStatus(chatId)
  return true
}

export function markChatTurnReady(chatId: number, turnId: string): void {
  const record = turns.get(chatId)?.get(turnId)
  if (!record) return
  record.phase = 'running'
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

/** Every chat with a turn starting or running. */
export function listBusyChats(): number[] {
  return [...turns.keys()]
}

export function isChatTurnStarting(chatId: number): boolean {
  for (const record of turns.get(chatId)?.values() ?? []) if (record.phase === 'starting') return true
  return false
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
  finishListeners.add(listener)
  return () => { finishListeners.delete(listener) }
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

/** The turn is over and its reply saved: unregister it, announce the chat's new status, tell observers. */
export function emitChatTurnFinished(event: ChatTurnFinished): void {
  const active = turns.get(event.chatId)
  const record = active?.get(event.turnId)
  if (record) {
    active!.delete(event.turnId)
    if (active!.size === 0) turns.delete(event.chatId)
    if (record.stream) keepFinishedStream(event.chatId, record.stream)
    emitStatus(event.chatId)
  }
  for (const listener of finishListeners) {
    try { listener(event) } catch (error) { console.warn('[chat-turn] finish observer failed', error) }
  }
}

function keepFinishedStream(chatId: number, stream: TurnStream): void {
  const previous = finishedStreams.get(chatId)
  if (previous) clearTimeout(previous.timer)
  const timer = setTimeout(() => {
    if (finishedStreams.get(chatId)?.stream === stream) finishedStreams.delete(chatId)
  }, FINISHED_STREAM_GRACE_MS)
  ;(timer as { unref?: () => void }).unref?.()
  finishedStreams.set(chatId, { stream, timer })
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
 * caller, so the wait gives up after `timeoutMs` and resolves `false`.
 */
export function waitForChatTurnIdle(chatId: number, timeoutMs = 5000, signal?: AbortSignal): Promise<boolean> {
  if (!isChatTurnBusy(chatId)) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let done = false
    const settle = (idle: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
      resolve(idle)
    }
    const onAbort = () => settle(false)
    const timer = setTimeout(() => settle(false), timeoutMs)
    const unsubscribe = onChatTurnFinished((event) => {
      if (event.chatId !== chatId) return
      if (!isChatTurnBusy(chatId)) settle(true)
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    // The turn may have ended between the check above and the subscription.
    if (!isChatTurnBusy(chatId)) settle(true)
  })
}
