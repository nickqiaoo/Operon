// Tee runtime stream parts to a JSONL file for later replay.
//
// Enabled by setting `OPERON_RECORD_TRAFFIC=1`. Each request gets its own file
// under `OPERON_TRAFFIC_DIR` (default: `<cwd>/test-results/traces`):
//
//   <ts>-<providerId>-chat<chatId>-<requestIdShort>.jsonl
//
// First line is a `meta-start` header with request context. Then one line per
// `RuntimeStreamPart`. Final line is a `meta-end` summarising how the stream
// terminated. The format is intentionally append-only and tolerant of partial
// writes so a crashed run still leaves a usable trace.

import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

import type { RuntimeStreamPart } from './types.js'

export interface TrafficRecorderContext {
  chatId: number
  requestId: string
  providerId: string
  modelId?: string
  modeId?: string
  cwd?: string
}

export interface TrafficRecorder {
  record(part: RuntimeStreamPart): void
  close(reason: 'completed' | 'error' | 'abort', error?: unknown): void
  /** Wraps an AsyncIterable so each yielded part is recorded as it passes through. */
  tee<T extends RuntimeStreamPart>(source: AsyncIterable<T>): AsyncIterable<T>
}

export function isTrafficRecordingEnabled(): boolean {
  return process.env.OPERON_RECORD_TRAFFIC === '1'
}

function resolveTraceDir(): string {
  const fromEnv = process.env.OPERON_TRAFFIC_DIR
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv)
  return resolve(process.cwd(), 'test-results', 'traces')
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)
}

function buildFileName(ctx: TrafficRecorderContext): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const provider = sanitize(ctx.providerId || 'unknown')
  const requestShort = sanitize(ctx.requestId).slice(0, 8) || 'noreq'
  return `${ts}-${provider}-chat${ctx.chatId}-${requestShort}.jsonl`
}

class JsonlTrafficRecorder implements TrafficRecorder {
  private stream: WriteStream
  private closed = false
  private partCount = 0
  readonly filePath: string

  constructor(ctx: TrafficRecorderContext) {
    const dir = resolveTraceDir()
    mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, buildFileName(ctx))
    this.stream = createWriteStream(this.filePath, { flags: 'a' })

    this.writeLine({
      type: 'meta-start',
      ts: Date.now(),
      chatId: ctx.chatId,
      requestId: ctx.requestId,
      providerId: ctx.providerId,
      modelId: ctx.modelId,
      modeId: ctx.modeId,
      cwd: ctx.cwd,
    })
  }

  private writeLine(obj: unknown): void {
    if (this.closed) return
    try {
      this.stream.write(JSON.stringify(obj) + '\n')
    } catch (err) {
      // Recording failures must never break the stream the user actually cares
      // about. Log once and silently disable for the rest of this request.
      console.error('[traffic-recorder] write failed:', err)
      this.closed = true
      try { this.stream.destroy() } catch { /* ignore */ }
    }
  }

  record(part: RuntimeStreamPart): void {
    this.partCount += 1
    this.writeLine({ type: 'part', ts: Date.now(), part })
  }

  close(reason: 'completed' | 'error' | 'abort', error?: unknown): void {
    if (this.closed) return
    this.writeLine({
      type: 'meta-end',
      ts: Date.now(),
      reason,
      partCount: this.partCount,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    })
    this.closed = true
    this.stream.end()
  }

  async *tee<T extends RuntimeStreamPart>(source: AsyncIterable<T>): AsyncIterable<T> {
    try {
      for await (const part of source) {
        this.record(part)
        yield part
      }
      this.close('completed')
    } catch (err) {
      this.close('error', err)
      throw err
    }
  }
}

export function createTrafficRecorder(ctx: TrafficRecorderContext): TrafficRecorder | null {
  if (!isTrafficRecordingEnabled()) return null
  try {
    return new JsonlTrafficRecorder(ctx)
  } catch (err) {
    console.error('[traffic-recorder] failed to initialise:', err)
    return null
  }
}
