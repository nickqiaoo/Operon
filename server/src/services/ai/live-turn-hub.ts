// Per-chat live turn buffer + presence hub.
//
// A turn's UIMessageChunk SSE bytes are tee'd in here as they stream back to
// whoever POSTed /api/ai/chat, so any *other* surface — the web client over the
// broker tunnel, a second desktop window, the phone — can attach to the same
// running turn instead of staring at a stale history snapshot.
//
// Event-level on purpose. The AI SDK reconciles UIMessageChunks by message/part
// id, so replaying the stream from its first event rebuilds the assistant
// message exactly; no seq/snapshot bookkeeping is needed. That is the same trick
// the broker already plays for web resume (broker/chat_buffer.go). The
// difference is that this one sits on the node, so it also captures turns the
// desktop started — those never touch the broker at all, which is precisely why
// the web client could not see them.
//
// A replay must start at the first event: drop the head and the SDK loses the
// `start` (so it cannot tell which message it is rebuilding) and the `*-start`
// of parts it then sees deltas for, and it rejects the stream. So a turn that
// outgrows its budget is compacted (`live-turn-compaction.ts` folds the delta
// envelopes that make up most of its bytes) rather than truncated. What is left
// is about the size of the reply itself, which this process already holds while
// it assembles the reply.
//
// In-memory on purpose too: the turn itself lives in this process, so a restart
// that loses the buffer has lost the turn with it. Persisted chat history stays
// the durable record (a running turn checkpoints its reply there as it goes);
// this is only the live window.

import { randomUUID } from 'crypto'
import { compactSseEvents, parseSseEvent } from './live-turn-compaction.js'

/** Finished turns stay replayable this long (client was offline when it ended). */
const TURN_TTL_MS = 10 * 60_000
/** Bounds an abandoned in-flight turn (never terminated, nobody attached). */
const TURN_IDLE_TTL_MS = 30 * 60_000
/** Buffered bytes past which a turn is compacted; after that, twice what compaction left. */
const TURN_COMPACT_BYTES = 32 * 1024 * 1024
/**
 * Compaction leaves alone what an attacher has not read yet. One that stalls
 * that long (its client stopped reading) is let go so the buffer can shrink; its
 * client sees the stream end and attaches again.
 */
const TURN_STALLED_READER_FACTOR = 2

const EVENT_SEPARATOR = '\n\n'

export interface LiveTurnStatus {
  chatId: number
  active: boolean
  turnId: string | null
  startedAt: number | null
}

type PresenceListener = (status: LiveTurnStatus) => void

interface ReaderCursor {
  /** Index of the next event to yield. */
  pos: number
  released: boolean
}

export class LiveTurn {
  readonly turnId = randomUUID()
  readonly chatId: number
  readonly startedAt = Date.now()
  readonly headers: Record<string, string>

  /** Complete SSE events, in stream order. */
  private events: Uint8Array[] = []
  private bytes = 0
  /** Text of an event still arriving. */
  private pending = ''
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()
  private readonly compactBytes: number
  private compactAt: number
  private readers = new Set<ReaderCursor>()
  private assistantMessageId: string | undefined
  private done = false
  private updated = Date.now()
  private waiters: Array<() => void> = []

  /** `compactBytes` overrides the compaction budget (tests). */
  constructor(chatId: number, headers: Record<string, string>, options?: { compactBytes?: number }) {
    this.chatId = chatId
    this.compactBytes = options?.compactBytes ?? TURN_COMPACT_BYTES
    this.compactAt = this.compactBytes
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

  /** Id of the assistant message this turn streams (from its `start` chunk), once seen. */
  get messageId(): string | undefined {
    return this.assistantMessageId
  }

  append(data: Uint8Array): void {
    if (this.done || data.length === 0) return
    this.pending += this.decoder.decode(data, { stream: true })
    let added = false
    for (;;) {
      const end = this.pending.indexOf(EVENT_SEPARATOR)
      if (end === -1) break
      this.pushEvent(this.pending.slice(0, end + EVENT_SEPARATOR.length))
      this.pending = this.pending.slice(end + EVENT_SEPARATOR.length)
      added = true
    }
    this.updated = Date.now()
    if (!added) return
    if (this.bytes > this.compactAt) this.compact()
    this.wake()
  }

  /** Everything buffered so far, decoded — for a reader that wants the turn as it stands, not a tail. */
  snapshot(): string {
    const decoder = new TextDecoder()
    return this.events.map((event) => decoder.decode(event, { stream: true })).join('') + decoder.decode()
  }

  finish(): void {
    if (this.done) return
    // A stream that ends mid-event still delivers what it had.
    this.pending += this.decoder.decode()
    if (this.pending) this.pushEvent(this.pending)
    this.pending = ''
    this.done = true
    this.updated = Date.now()
    this.wake()
  }

  /**
   * Replay everything buffered so far, then tail until the turn ends or the
   * caller disconnects. Yields raw SSE bytes, one event per chunk.
   */
  async *read(signal?: AbortSignal): AsyncIterable<Uint8Array> {
    const cursor: ReaderCursor = { pos: 0, released: false }
    this.readers.add(cursor)
    try {
      for (;;) {
        if (signal?.aborted || cursor.released) return
        while (cursor.pos < this.events.length) {
          const event = this.events[cursor.pos]
          cursor.pos += 1
          if (event) yield event
          if (signal?.aborted || cursor.released) return
        }
        if (this.done) return
        await this.waitForChange(signal)
      }
    } finally {
      this.readers.delete(cursor)
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

  private pushEvent(text: string): void {
    const event = this.encoder.encode(text)
    this.events.push(event)
    this.bytes += event.length
    if (this.assistantMessageId === undefined && text.includes('"type":"start"')) {
      const chunk = parseSseEvent(event)
      if (chunk?.type === 'start' && typeof chunk.messageId === 'string') this.assistantMessageId = chunk.messageId
    }
  }

  /**
   * Fold the events every attacher has already read (all of them when none is
   * attached). Readers keep their place: their cursor moves by however many
   * events the folded prefix lost.
   */
  private compact(): void {
    if (this.bytes > this.compactAt * TURN_STALLED_READER_FACTOR) {
      // Waited a whole extra budget on an attacher that is not reading.
      for (const reader of this.readers) {
        if (reader.pos < this.events.length) reader.released = true
      }
    }
    let upTo = this.events.length
    for (const reader of this.readers) {
      if (!reader.released) upTo = Math.min(upTo, reader.pos)
    }
    if (upTo === 0) return

    const before = this.events.length
    const folded = compactSseEvents(this.events.slice(0, upTo))
    this.events = folded.concat(this.events.slice(upTo))
    const shift = upTo - folded.length
    for (const reader of this.readers) {
      reader.pos = reader.released ? this.events.length : reader.pos - shift
    }
    this.bytes = this.events.reduce((sum, event) => sum + event.length, 0)
    this.compactAt = Math.max(this.compactBytes, this.bytes * 2)
    console.info('[ai.liveTurn.compact]', {
      chatId: this.chatId,
      events: `${before}→${this.events.length}`,
      bytes: this.bytes,
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
