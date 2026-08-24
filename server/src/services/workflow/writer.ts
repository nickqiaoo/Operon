/**
 * The write side of one run: batching, and the only size limit in the system.
 *
 * Sub-agent output arrives one UIMessageChunk per token. Appending a row each
 * would be one INSERT per token, so chunks are coalesced per agent and flushed
 * on a size or time trigger. Everything else is appended immediately — those
 * events are rare and their ordering is what the panel reads.
 *
 * The cap is a BYTE budget per agent, not a chunk count. The count-based cap
 * this replaces was wrong in both directions at once: a talkative agent hit
 * 4000 text-deltas after a couple of thousand tokens and lost its tail, while an
 * agent making a few enormous tool calls could write tens of megabytes and never
 * reach the limit.
 */

import { appendEvent, appendEvents } from './store.js'
import type { WorkflowEvent } from './events.js'

/** Per sub-agent recording budget. Generous for a normal turn; a guard, not a quota. */
const MAX_AGENT_BYTES = 2 * 1024 * 1024

/** Flush triggers for buffered chunks. */
const FLUSH_CHUNKS = 64
const FLUSH_BYTES = 64 * 1024
const FLUSH_MS = 250

interface AgentBuffer {
  chunks: unknown[]
  /** Approximate serialized size buffered but not yet written. */
  pendingBytes: number
  /** Approximate serialized size already written for this agent. */
  writtenBytes: number
  /** True once the budget was hit and a `truncated` event was appended. */
  capped: boolean
}

export class RunEventWriter {
  private readonly runId: string
  private readonly buffers = new Map<number, AgentBuffer>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(runId: string) {
    this.runId = runId
  }

  /**
   * Append a run-level event.
   *
   * Flushes buffered chunks first so the log stays in real order — an agent's
   * `settled` patch must never land before the output that produced it.
   */
  emit(event: WorkflowEvent): void {
    if (this.disposed) return
    this.flush()
    appendEvent(this.runId, event)
  }

  /** Buffer one sub-agent chunk. */
  chunk(index: number, chunk: unknown): void {
    if (this.disposed) return
    let buffer = this.buffers.get(index)
    if (!buffer) {
      buffer = { chunks: [], pendingBytes: 0, writtenBytes: 0, capped: false }
      this.buffers.set(index, buffer)
    }
    if (buffer.capped) return

    const size = approximateSize(chunk)
    if (buffer.writtenBytes + buffer.pendingBytes + size > MAX_AGENT_BYTES) {
      // Flush what fits, then record the cut once. The panel shows a "tail is
      // missing" notice off this event rather than silently displaying a partial
      // run as if it were whole.
      buffer.capped = true
      this.flush()
      appendEvent(this.runId, { kind: 'truncated', index })
      return
    }

    buffer.chunks.push(chunk)
    buffer.pendingBytes += size
    if (buffer.chunks.length >= FLUSH_CHUNKS || buffer.pendingBytes >= FLUSH_BYTES) {
      this.flush()
      return
    }
    this.schedule()
  }

  /** Write every buffered chunk now. */
  flush(): void {
    this.clearTimer()
    const events: WorkflowEvent[] = []
    for (const [index, buffer] of this.buffers) {
      if (buffer.chunks.length === 0) continue
      events.push({ kind: 'chunk', index, chunks: buffer.chunks })
      buffer.writtenBytes += buffer.pendingBytes
      buffer.chunks = []
      buffer.pendingBytes = 0
    }
    if (events.length > 0) appendEvents(this.runId, events)
  }

  /** Final flush; the writer accepts nothing afterwards. */
  dispose(): void {
    if (this.disposed) return
    this.flush()
    this.disposed = true
    this.buffers.clear()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_MS)
    // A pending flush must never be the reason the process stays alive.
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

/**
 * Cheap size estimate. `JSON.stringify` on every chunk would double the
 * serialization cost of the stream; the length of a chunk's text payload plus a
 * flat overhead tracks the real thing closely enough for a guard rail.
 */
function approximateSize(chunk: unknown): number {
  if (chunk == null || typeof chunk !== 'object') return 32
  let total = 64
  for (const value of Object.values(chunk as Record<string, unknown>)) {
    if (typeof value === 'string') total += value.length
    else if (value != null && typeof value === 'object') total += JSON.stringify(value).length
    else total += 8
  }
  return total
}
