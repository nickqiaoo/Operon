import type { OpenCodeEvent } from '@opencode/client'
import type { OpencodeLogger } from './types.js'

type ConnectedEvent = Extract<OpenCodeEvent, { type: 'server.connected' }>

/** Opens the server's event stream; the hub ends it through `signal`. */
export type OpenEventStream = (signal: AbortSignal) => AsyncIterable<OpenCodeEvent>

/** One reader of the hub: every event from the moment it subscribed, in order. */
export interface EventSubscription extends AsyncIterator<OpenCodeEvent> {
  /** Events already received and not yet read. */
  pending(): readonly OpenCodeEvent[]
  /** Skip the first `count` unread events. */
  drop(count: number): void
}

const RECONNECT_DELAY_MS = 1000

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

class Subscriber implements EventSubscription {
  private readonly queue: OpenCodeEvent[] = []
  private waiting: { resolve: (result: IteratorResult<OpenCodeEvent>) => void; reject: (error: unknown) => void } | null = null
  private ended: { error?: unknown } | null = null
  private readonly onAbort = () => this.end(abortError())

  constructor(private readonly detach: (subscriber: Subscriber) => void, private readonly signal?: AbortSignal) {
    if (signal?.aborted) this.ended = { error: abortError() }
    else signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  push(event: OpenCodeEvent): void {
    if (this.ended) return
    if (this.waiting) {
      const { resolve } = this.waiting
      this.waiting = null
      resolve({ value: event, done: false })
    } else {
      this.queue.push(event)
    }
  }

  /** No more events: a clean end reads as `done`, a failure (or abort) rejects. */
  end(error?: unknown): void {
    if (this.ended) return
    this.ended = error === undefined ? {} : { error }
    this.signal?.removeEventListener('abort', this.onAbort)
    this.detach(this)
    if (!this.waiting) return
    const waiting = this.waiting
    this.waiting = null
    if (error === undefined) waiting.resolve({ value: undefined, done: true })
    else waiting.reject(error)
  }

  pending(): readonly OpenCodeEvent[] {
    return this.queue
  }

  drop(count: number): void {
    this.queue.splice(0, count)
  }

  next(): Promise<IteratorResult<OpenCodeEvent>> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve({ value: queued, done: false })
    if (this.ended) {
      return this.ended.error === undefined
        ? Promise.resolve({ value: undefined, done: true })
        : Promise.reject(this.ended.error)
    }
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject }
    })
  }

  return(): Promise<IteratorResult<OpenCodeEvent>> {
    this.queue.length = 0
    this.end()
    return Promise.resolve({ value: undefined, done: true })
  }
}

/**
 * One event stream per session, shared by everything that reads it.
 *
 * A turn used to open its own stream and close it when the parent went idle.
 * Since OpenCode 2.3 a sub-agent runs in the background: the call that launches
 * it returns at once, the turn ends, and the sub-agent's steps, its report and
 * the reply the parent then starts on its own all arrive after that. The hub
 * keeps the stream open while anyone needs it — a reader (a turn), or the
 * session's `keepAlive` (a background sub-agent still running) — and closes it
 * when nobody does, so an idle conversation holds no connection.
 *
 * `observe` sees every event first, synchronously and in order, before any
 * reader: what it decides (a reply the parent started on its own) is settled
 * before the next event is handed out.
 */
export class OpencodeEventHub {
  private readonly subscribers = new Set<Subscriber>()
  private connection: { controller: AbortController; connected: boolean } | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectedEvent: ConnectedEvent | null = null
  private closed = false

  constructor(
    private readonly open: OpenEventStream,
    private readonly observe: (event: OpenCodeEvent) => void,
    private readonly keepAlive: () => boolean,
    private readonly logger: OpencodeLogger,
  ) {}

  /**
   * Read events from now on. The first one is always `server.connected`, once
   * the stream is up, so a caller can wait for it before sending anything whose
   * events it must not miss.
   */
  subscribe(signal?: AbortSignal): EventSubscription {
    const subscriber = new Subscriber((detached) => this.detach(detached), signal)
    if (signal?.aborted) return subscriber
    this.subscribers.add(subscriber)
    if (this.connection?.connected && this.connectedEvent) subscriber.push(this.connectedEvent)
    else this.ensureConnected()
    return subscriber
  }

  /** Close the stream if nobody needs it any more (call when `keepAlive` may have turned false). */
  release(): void {
    if (this.subscribers.size === 0 && !this.keepAlive()) this.disconnect()
  }

  /** Open the stream if it is not (call when `keepAlive` turned true). */
  retain(): void {
    if (!this.closed) this.ensureConnected()
  }

  close(): void {
    this.closed = true
    for (const subscriber of [...this.subscribers]) subscriber.end()
    this.disconnect()
  }

  private detach(subscriber: Subscriber): void {
    if (!this.subscribers.delete(subscriber)) return
    this.release()
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const connection = this.connection
    this.connection = null
    connection?.controller.abort()
  }

  private ensureConnected(): void {
    if (this.connection || this.closed) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const connection = { controller: new AbortController(), connected: false }
    this.connection = connection
    void this.pump(connection)
  }

  private async pump(connection: { controller: AbortController; connected: boolean }): Promise<void> {
    let failure: unknown
    try {
      for await (const event of this.open(connection.controller.signal)) {
        if (this.connection !== connection) return
        if (event.type === 'server.connected') {
          connection.connected = true
          this.connectedEvent = event
          for (const subscriber of this.subscribers) subscriber.push(event)
          continue
        }
        try {
          this.observe(event)
        } catch (error) {
          this.logger.warn(`[event-hub] observer failed on ${event.type}: ${error instanceof Error ? error.message : String(error)}`)
        }
        for (const subscriber of this.subscribers) subscriber.push(event)
      }
    } catch (error) {
      failure = error
    }
    if (this.connection !== connection) return
    this.connection = null
    // Readers see the stream end as it did when each turn owned its own: a turn
    // still waiting for its completion reports the disconnect.
    for (const subscriber of [...this.subscribers]) subscriber.end(failure)
    if (failure !== undefined) this.logger.warn(`[event-hub] event stream failed: ${failure instanceof Error ? failure.message : String(failure)}`)
    if (!this.closed && this.keepAlive()) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (this.keepAlive()) this.ensureConnected()
      }, RECONNECT_DELAY_MS)
    }
  }
}
