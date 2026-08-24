import type { OutboundFrame } from './frames.js'

// uploader.ts is the node→broker uplink: frames are batched into discrete JSON
// POSTs rather than streamed down one endless request body. CDNs and corporate
// proxies buffer request bodies in full before forwarding, so a body that never ends
// never reaches the origin at all — which is what made the streaming design
// unusable behind Cloudflare.
//
// The contract with the broker (see broker/agent_conn.go applyBatch):
//
//   * At most ONE POST in flight. Wire order is therefore generation order, so the
//     broker needs no reordering buffer and no per-event ids.
//   * `seq` increments only when a new batch is taken, i.e. only after the previous
//     one was acknowledged. A gap is therefore impossible, and the broker treats one
//     as a fatal protocol violation.
//   * A retry re-sends the SAME seq. The broker dedups by watermark without reading
//     the payload, so retries need not reproduce their contents byte-for-byte.
//
// Throughput does not suffer from serialising: frames generated while a POST is in
// flight accumulate, so an idle tunnel sends one frame per round trip while a busy
// one automatically forms large batches. No fixed flush window is needed, which is
// why terminal echo stays crisp.

/** Soft target for one POST. A single frame is never split, so a batch can exceed it. */
const BATCH_TARGET_BYTES = 4 << 20
/**
 * Backlog caps, applied per class so a chatty terminal can never squeeze out a chat
 * turn. Terminal output is a live view with no value once stale; response bodies are
 * the actual product, so they get an order of magnitude more room.
 */
const WS_BACKLOG_LIMIT_BYTES = 16 << 20
const RESP_BACKLOG_LIMIT_BYTES = 128 << 20
/** Rough per-frame JSON overhead, for budgeting only. */
const FRAME_OVERHEAD_BYTES = 256

/**
 * How long a quiet uplink may stay silent. The broker has no socket to probe on this
 * leg, so an empty batch is the only evidence it gets that the uplink still works;
 * its own stall backstop is far longer than this (see uplinkStallTimeout).
 */
const IDLE_KEEPALIVE_MS = 60_000
const KEEPALIVE_CHECK_MS = 20_000
/**
 * Generous, because a slow POST is not a failed one: the broker holds the request
 * open while a slow consumer drains the batch, and that backpressure is intentional.
 * Retrying early would only pile duplicates onto a connection that is already behind.
 */
const REQUEST_TIMEOUT_MS = 120_000
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 30_000

/** Statuses that mean the connection itself is gone — retrying cannot help. */
const FATAL_STATUSES = new Set([403, 404, 409])

export interface UploaderOptions {
  brokerUrl: string
  secret: string
  connId: string
  /** Aborted when the connection tears down. */
  signal: AbortSignal
  /** The connection is unrecoverable; the caller should tear down and reconnect. */
  onFatal: (reason: string) => void
}

export class Uploader {
  private readonly opts: UploaderOptions
  private readonly queue: OutboundFrame[] = []
  /** Ids whose backlog was shed; their remaining frames are dropped, not queued. */
  private readonly poisoned = new Set<string>()
  private wsBytes = 0
  private respBytes = 0
  private seq = 0
  private inflight = false
  private stopped = false
  private lastSentAt = Date.now()
  private keepaliveDue = false
  private readonly keepaliveTimer: ReturnType<typeof setInterval>

  constructor(opts: UploaderOptions) {
    this.opts = opts
    this.keepaliveTimer = setInterval(() => this.onKeepaliveTick(), KEEPALIVE_CHECK_MS)
    // Don't hold the process open just for the heartbeat.
    this.keepaliveTimer.unref?.()
  }

  enqueue(f: OutboundFrame): void {
    if (this.stopped) return
    const id = frameId(f)
    if (id !== undefined && this.poisoned.has(id)) {
      // Backlog for this response was already shed and a res-error queued in its
      // place. Keep dropping until the local read finishes on its own — we never
      // abort it, because the turn behind it is real work the tunnel doesn't own.
      if (f.t === 'res-end' || f.t === 'res-error') this.poisoned.delete(id)
      return
    }
    if (this.coalesce(f)) {
      this.shedIfNeeded()
      void this.pump()
      return
    }
    this.queue.push(f)
    this.addBytes(f, 1)
    this.shedIfNeeded()
    void this.pump()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.keepaliveTimer)
    this.queue.length = 0
    this.poisoned.clear()
    this.wsBytes = 0
    this.respBytes = 0
  }

  /**
   * Merge a response chunk into the one already queued for the same id. Same-id
   * chunks are just consecutive slices of one HTTP body, so concatenation is exact —
   * no snapshot/versioning scheme is needed. Only textual chunks merge: base64 pieces
   * are padded independently and would need a decode/re-encode round trip for a much
   * smaller relative saving.
   */
  private coalesce(f: OutboundFrame): boolean {
    if (f.t !== 'res-chunk' || f.enc !== undefined) return false
    const last = this.queue[this.queue.length - 1]
    if (last?.t !== 'res-chunk' || last.id !== f.id || last.enc !== undefined) return false
    last.data += f.data
    this.respBytes += f.data.length
    return true
  }

  /**
   * Enforce the backlog caps. This runs when the uplink is stalled and frames are
   * piling up; the goal is to bound memory WITHOUT tearing the connection down,
   * because a teardown costs far more than a dropped view.
   */
  private shedIfNeeded(): void {
    while (this.wsBytes > WS_BACKLOG_LIMIT_BYTES) {
      const i = this.queue.findIndex((f) => f.t === 'ws-msg')
      if (i < 0) break
      const [dropped] = this.queue.splice(i, 1)
      if (dropped) this.addBytes(dropped, -1)
    }
    while (this.respBytes > RESP_BACKLOG_LIMIT_BYTES) {
      const id = this.largestQueuedResponse()
      if (id === undefined) break
      this.shedResponse(id)
    }
  }

  private largestQueuedResponse(): string | undefined {
    const bytes = new Map<string, number>()
    for (const f of this.queue) {
      if (f.t !== 'res-chunk') continue
      bytes.set(f.id, (bytes.get(f.id) ?? 0) + frameBytes(f))
    }
    let worst: string | undefined
    let worstBytes = 0
    for (const [id, n] of bytes) {
      if (n > worstBytes) {
        worst = id
        worstBytes = n
      }
    }
    return worst
  }

  /**
   * Drop one response's backlog and queue a res-error in its place, so the browser
   * gets a clean failure instead of a silently truncated body. The content is not
   * lost: the node persists chat turns locally regardless of the tunnel, so the
   * client recovers via resume.
   */
  private shedResponse(id: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const f = this.queue[i]
      if (f?.t === 'res-chunk' && f.id === id) {
        this.addBytes(f, -1)
        this.queue.splice(i, 1)
      }
    }
    this.poisoned.add(id)
    const err: OutboundFrame = {
      t: 'res-error',
      id,
      status: 503,
      code: 'uplink_backlog',
      message: 'tunnel uplink backlog exceeded; reload or resume to continue',
    }
    this.queue.push(err)
    this.addBytes(err, 1)
    console.warn(`[agent] shed uplink backlog for request ${id}`)
  }

  private addBytes(f: OutboundFrame, sign: 1 | -1): void {
    const n = frameBytes(f) * sign
    if (f.t === 'ws-msg') this.wsBytes += n
    else this.respBytes += n
  }

  private onKeepaliveTick(): void {
    if (this.stopped || this.inflight) return
    if (Date.now() - this.lastSentAt < IDLE_KEEPALIVE_MS) return
    this.keepaliveDue = true
    void this.pump()
  }

  /**
   * The serial driver. Only one instance runs at a time (`inflight`); anything
   * enqueued while it is running is picked up by the loop, so a busy tunnel forms
   * successively larger batches instead of one round trip per frame.
   */
  private async pump(): Promise<void> {
    if (this.inflight || this.stopped) return
    if (this.queue.length === 0 && !this.keepaliveDue) return
    this.inflight = true
    try {
      while (!this.stopped && (this.queue.length > 0 || this.keepaliveDue)) {
        const batch = this.takeBatch()
        this.keepaliveDue = false
        if (!(await this.postWithRetry(++this.seq, batch))) return
      }
    } finally {
      this.inflight = false
    }
  }

  /** Take frames up to the size target; always at least one if any are queued. */
  private takeBatch(): OutboundFrame[] {
    const batch: OutboundFrame[] = []
    let bytes = 0
    for (;;) {
      const f = this.queue[0]
      if (f === undefined) break
      const n = frameBytes(f)
      if (batch.length > 0 && bytes + n > BATCH_TARGET_BYTES) break
      this.queue.shift()
      this.addBytes(f, -1)
      batch.push(f)
      bytes += n
    }
    return batch
  }

  /**
   * Retry indefinitely on transient failures. There is deliberately no attempt cap:
   * giving up would mean dropping frames or tearing down a connection whose agent is
   * still working perfectly well, and a stalled uplink is survivable — the browser is
   * held warm by the broker's SSE keepalives and catches up when the network returns.
   */
  private async postWithRetry(seq: number, events: OutboundFrame[]): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      if (this.stopped) return false
      try {
        const res = await this.post(seq, events)
        if (res.ok) {
          this.lastSentAt = Date.now()
          return true
        }
        if (FATAL_STATUSES.has(res.status)) {
          this.fatal(`uplink rejected: ${res.status}`)
          return false
        }
      } catch {
        if (this.opts.signal.aborted || this.stopped) return false
      }
      const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)
      if (attempt === 0) console.warn('[agent] uplink stalled; retrying until it recovers')
      await this.sleep(delay)
    }
  }

  private post(seq: number, events: OutboundFrame[]): Promise<Response> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    return fetch(`${this.opts.brokerUrl}/agent/up?connId=${encodeURIComponent(this.opts.connId)}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ seq, events }),
      signal: AbortSignal.any([this.opts.signal, timeout]),
    })
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      t.unref?.()
      this.opts.signal.addEventListener('abort', () => {
        clearTimeout(t)
        resolve()
      }, { once: true })
    })
  }

  private fatal(reason: string): void {
    if (this.stopped) return
    console.error(`[agent] ${reason}`)
    this.opts.onFatal(reason)
  }
}

function frameId(f: OutboundFrame): string | undefined {
  return 'id' in f ? f.id : undefined
}

function frameBytes(f: OutboundFrame): number {
  const data = 'data' in f ? f.data : undefined
  const message = 'message' in f ? f.message : undefined
  return FRAME_OVERHEAD_BYTES + (data?.length ?? 0) + (message?.length ?? 0)
}
