// One chat turn's reply, as a stream every surface showing the chat subscribes to.
//
// A turn runs on this node whoever is watching it. Its UI chunks are published
// here, and the window that sent the message, a second window, the web client
// over the broker tunnel and the phone are all subscribers of the same stream.
// The requester is not special: its POST is answered with a subscription like
// any reconnect, so there is one path, and a requester that goes away is just a
// subscriber leaving.
//
// Subscribing hands over the reply as it stands (see `turn-stream-fold.ts`) and
// then every chunk after it, taken in one synchronous step so nothing falls
// between the two. A subscriber that stops reading is cut off once its backlog
// passes a budget; its client sees the stream fail and subscribes again, which
// costs one folded snapshot rather than the whole turn.
//
// This is content only. Whether a chat has a turn running, and which stream is
// the chat's current one, is the turn registry's (`chat-turn-lifecycle.ts`).
//
// In-memory on purpose: the turn itself lives in this process, so a restart
// that loses the stream has lost the turn with it. Persisted chat history is
// the durable record — the turn checkpoints its reply there as it goes and
// saves it before the stream ends.

import type { UIMessageChunk } from 'ai'
import { ChunkFold } from './turn-stream-fold.js'

/** Unread bytes, past the snapshot it started with, at which a subscriber is cut off. */
const SUBSCRIBER_BACKLOG_BYTES = 16 * 1024 * 1024

interface Subscriber {
  push(chunk: UIMessageChunk): void
  close(): void
}

const weights = new WeakMap<object, number>()

/** About how many bytes a chunk takes on the wire; computed once per chunk object. */
function chunkWeight(chunk: UIMessageChunk): number {
  const cached = weights.get(chunk)
  if (cached !== undefined) return cached
  const delta = (chunk as { delta?: unknown; inputTextDelta?: unknown }).delta ??
    (chunk as { inputTextDelta?: unknown }).inputTextDelta
  const weight = typeof delta === 'string' ? delta.length + 64 : JSON.stringify(chunk).length
  weights.set(chunk, weight)
  return weight
}

export class TurnStream {
  /** The turn this is the reply of — its request id, the same id the turn registry reports. */
  readonly turnId: string
  /** The assistant message this turn streams. Known once the turn has set up. */
  messageId: string | undefined

  private readonly fold = new ChunkFold()
  private readonly subscribers = new Set<Subscriber>()
  private done = false

  constructor(turnId: string, messageId?: string) {
    this.turnId = turnId
    this.messageId = messageId
  }

  get isDone(): boolean {
    return this.done
  }

  /** Add the next chunk of the reply and hand it to every subscriber. */
  publish(chunk: UIMessageChunk): void {
    if (this.done) return
    this.fold.add(chunk)
    for (const subscriber of this.subscribers) subscriber.push(chunk)
  }

  /** The turn is over (its reply already saved): close every subscriber once it has read what is queued. */
  end(): void {
    if (this.done) return
    this.done = true
    for (const subscriber of this.subscribers) subscriber.close()
    this.subscribers.clear()
  }

  /** The reply so far as UI chunks — for a server-side reader that wants the turn as it stands. */
  snapshotChunks(): UIMessageChunk[] {
    return this.fold.chunks()
  }

  /**
   * The reply so far, then every chunk until the turn ends. Cancelling the
   * stream (its client went away) only removes this subscriber.
   */
  subscribe(): ReadableStream<UIMessageChunk> {
    let subscriber: Subscriber | undefined
    let snapshotWeight = 0
    const remove = (): void => {
      if (subscriber) this.subscribers.delete(subscriber)
      subscriber = undefined
    }
    return new ReadableStream<UIMessageChunk>(
      {
        // Runs synchronously in the constructor: the snapshot and the
        // registration happen with no chunk able to land between them.
        start: (controller) => {
          for (const chunk of this.fold.chunks()) {
            snapshotWeight += chunkWeight(chunk)
            controller.enqueue(chunk)
          }
          if (this.done) {
            controller.close()
            return
          }
          const own: Subscriber = {
            push: (chunk) => {
              try {
                controller.enqueue(chunk)
              } catch {
                remove()
                return
              }
              const desired = controller.desiredSize
              if (desired !== null && desired < -snapshotWeight) {
                console.warn('[ai.turnStream.subscriber.dropped]', { turnId: this.turnId })
                remove()
                controller.error(new Error('Turn stream reader fell behind'))
              }
            },
            close: () => {
              subscriber = undefined
              try {
                controller.close()
              } catch {
                // already cancelled
              }
            },
          }
          subscriber = own
          this.subscribers.add(own)
        },
        cancel: remove,
      },
      { highWaterMark: SUBSCRIBER_BACKLOG_BYTES, size: (chunk) => (chunk ? chunkWeight(chunk) : 0) },
    )
  }
}
