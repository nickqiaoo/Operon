// Per-chat live turn buffer + presence hub.
//
// A turn's UIMessageChunk SSE bytes are tee'd in here as they stream back to
// whoever POSTed /api/ai/chat, so any *other* surface — the web client over the
// broker tunnel, a second desktop window, the phone — can attach to the same
// running turn instead of staring at a stale history snapshot.
//
// Byte-level on purpose. The AI SDK reconciles UIMessageChunks by message/part
// id, so replaying the raw stream from the start rebuilds the assistant message
// exactly; no seq/snapshot bookkeeping is needed. That is the same trick the
// broker already plays for web resume (broker/chat_buffer.go). The difference
// is that this one sits on the node, so it also captures turns the desktop
// started — those never touch the broker at all, which is precisely why the web
// client could not see them.
//
// In-memory on purpose too: the turn itself lives in this process, so a restart
// that loses the buffer has lost the turn with it. Persisted chat history stays
// the durable record; this is only the live window.

import { randomUUID } from 'crypto'

/** Finished turns stay replayable this long (client was offline when it ended). */
const TURN_TTL_MS = 10 * 60_000
/** Bounds an abandoned in-flight turn (never terminated, nobody attached). */
const TURN_IDLE_TTL_MS = 30 * 60_000
/** Caps one turn's buffered bytes; past this the head is evicted. */
const TURN_MAX_BYTES = 32 * 1024 * 1024

export interface LiveTurnStatus {
  chatId: number
  active: boolean
  turnId: string | null
  startedAt: number | null
}

type PresenceListener = (status: LiveTurnStatus) => void

export class LiveTurn {
  readonly turnId = randomUUID()
  readonly chatId: number
  readonly startedAt = Date.now()
  readonly headers: Record<string, string>

  private chunks: Uint8Array[] = []
  private bytes = 0
  /** Chunks evicted from the head, so readers can index absolutely. */
  private dropped = 0
  private done = false
  private updated = Date.now()
  private waiters: Array<() => void> = []

  constructor(chatId: number, headers: Record<string, string>) {
    this.chatId = chatId
    // Every copy of this turn's stream — the requester's response and every
    // replay — identifies which turn it is. That is what lets a surface tell
    // "the turn I started" from "a turn someone else started", which a status
    // check cannot: a preempted surface is still 'streaming' when the peer's
    // turn is announced.
    this.headers = { ...headers, 'X-Turn-Id': this.turnId }
  }

  get isDone(): boolean {
    return this.done
  }

  get lastActivityAt(): number {
    return this.updated
  }

  append(data: Uint8Array): void {
    if (this.done || data.length === 0) return
    this.chunks.push(data)
    this.bytes += data.length
    // Evict from the head rather than refusing new data: a reader that joins
    // late still wants the tail. Pathologically large turns lose their opening,
    // and the client falls back to persisted history for the rest.
    while (this.bytes > TURN_MAX_BYTES && this.chunks.length > 1) {
      const head = this.chunks.shift()
      if (!head) break
      this.bytes -= head.length
      this.dropped += 1
    }
    this.updated = Date.now()
    this.wake()
  }

  finish(): void {
    if (this.done) return
    this.done = true
    this.updated = Date.now()
    this.wake()
  }

  /**
   * Replay everything buffered so far, then tail until the turn ends or the
   * caller disconnects. Yields raw SSE bytes.
   */
  async *read(signal?: AbortSignal): AsyncIterable<Uint8Array> {
    let idx = this.dropped
    for (;;) {
      if (signal?.aborted) return
      // A concurrent eviction can move the head past our cursor; skip forward
      // rather than replaying an out-of-range slot.
      if (idx < this.dropped) idx = this.dropped
      while (idx - this.dropped < this.chunks.length) {
        const chunk = this.chunks[idx - this.dropped]
        idx += 1
        if (chunk) yield chunk
      }
      if (this.done) return
      await this.waitForChange(signal)
    }
  }

  toReadableStream(signal?: AbortSignal): ReadableStream<Uint8Array> {
    const iterator = this.read(signal)[Symbol.asyncIterator]()
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await iterator.next()
          if (done) {
            controller.close()
            return
          }
          controller.enqueue(value)
        } catch (err) {
          controller.error(err)
        }
      },
      cancel() {
        void iterator.return?.(undefined)
      },
    })
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  private waitForChange(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      this.waiters.push(finish)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }
}

const turns = new Map<number, LiveTurn>()
const presence = new Map<number, Set<PresenceListener>>()
/**
 * Listeners that want EVERY chat's presence, not one chat's. The client keeps a
 * single stream for all conversations rather than one per open tab — see
 * `src/lib/live-turn-events.ts` for why that mattered.
 */
const allPresence = new Set<PresenceListener>()

/**
 * Open a live window for a new turn on `chatId`. A new turn supersedes the
 * previous one's buffer — the client that was tailing the old turn sees it end
 * and re-attaches.
 */
export function startLiveTurn(chatId: number, headers: Record<string, string>): LiveTurn {
  const previous = turns.get(chatId)
  if (previous && !previous.isDone) previous.finish()
  const turn = new LiveTurn(chatId, headers)
  turns.set(chatId, turn)
  emitPresence(chatId)
  return turn
}

/** The buffered turn for `chatId`, running or recently finished. */
export function getLiveTurn(chatId: number): LiveTurn | undefined {
  return turns.get(chatId)
}

export function getLiveTurnStatus(chatId: number): LiveTurnStatus {
  const turn = turns.get(chatId)
  const active = turn != null && !turn.isDone
  return {
    chatId,
    active,
    turnId: active ? turn.turnId : null,
    startedAt: active ? turn.startedAt : null,
  }
}

/** Notify other surfaces that a turn started/ended on this chat. */
export function subscribeLiveTurnPresence(chatId: number, listener: PresenceListener): () => void {
  let listeners = presence.get(chatId)
  if (!listeners) {
    listeners = new Set()
    presence.set(chatId, listeners)
  }
  listeners.add(listener)
  return () => {
    const set = presence.get(chatId)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) presence.delete(chatId)
  }
}

/** Notify a listener about turn start/end on ANY chat. */
export function subscribeAllLiveTurnPresence(listener: PresenceListener): () => void {
  allPresence.add(listener)
  return () => {
    allPresence.delete(listener)
  }
}

/**
 * Every chat with a turn running right now. Sent as the connect-time snapshot of
 * the all-chats stream: a chat absent from this list has no live turn, which is
 * what lets one stream answer for conversations it was never told about.
 */
export function listActiveLiveTurnStatuses(): LiveTurnStatus[] {
  const statuses: LiveTurnStatus[] = []
  for (const [chatId, turn] of turns) {
    if (!turn.isDone) statuses.push(getLiveTurnStatus(chatId))
  }
  return statuses
}

export function emitPresence(chatId: number): void {
  const listeners = presence.get(chatId)
  if ((!listeners || listeners.size === 0) && allPresence.size === 0) return
  const status = getLiveTurnStatus(chatId)
  const notify = (listener: PresenceListener): void => {
    try {
      listener(status)
    } catch (err) {
      console.warn('[ai.liveTurn.presence.error]', {
        chatId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (listeners) for (const listener of listeners) notify(listener)
  for (const listener of allPresence) notify(listener)
}

/**
 * Copy a tee'd branch of the client response into the buffer. Runs detached —
 * it must keep draining even after the originating client disconnects, since
 * that is exactly the case where another surface needs the tail.
 */
export async function pumpToLiveTurn(
  source: ReadableStream<Uint8Array>,
  turn: LiveTurn
): Promise<void> {
  const reader = source.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) turn.append(value)
    }
  } catch (err) {
    console.warn('[ai.liveTurn.pump.error]', {
      chatId: turn.chatId,
      message: err instanceof Error ? err.message : String(err),
    })
  } finally {
    turn.finish()
    emitPresence(turn.chatId)
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

const janitor = setInterval(() => {
  const now = Date.now()
  for (const [chatId, turn] of turns) {
    const age = now - turn.lastActivityAt
    const expired = (turn.isDone && age > TURN_TTL_MS) || age > TURN_IDLE_TTL_MS
    if (expired) turns.delete(chatId)
  }
}, 60_000)
if (typeof (janitor as unknown as { unref?: () => void }).unref === 'function') {
  ;(janitor as unknown as { unref: () => void }).unref()
}
