import type { ModelMessage } from 'ai'
import type { MemoryMaintenanceStorageAdapter } from '../../storage/interface.js'
import { createMaintenanceLogger } from './logger.js'
import { loadMessagesAfter } from './transcript.js'
import { compactTranscript, estimateTokens } from './compactor.js'
import { chunkTranscript } from './chunking.js'
import { buildExtractSystemPrompt } from './prompt.js'
import { runHeadlessMemoryAgent } from './headless.js'

const logger = createMaintenanceLogger('memory-extractor')

const IN_FLIGHT_THRESHOLD_MS = 2 * 60 * 60_000 // skip chats still active in last 2h
const RECENT_WINDOW_MS = 24 * 60 * 60_000 // only consider chats updated in last 24h
const MAX_CHUNKS_PER_SESSION = 10

export interface ExtractorOptions {
  providerId: string
  modelId?: string
  cwd: string
  maxSessionsPerRun: number
  signal?: AbortSignal
}

export interface ExtractorStats {
  sessionsProcessed: number
  chunksProcessed: number
  memoriesWritten: number
  memoriesSearched: number
  tokensInput: number
  tokensOutput: number
  errors: string[]
}

/**
 * Layer 1 — per-chat extraction.
 *
 * Pulls chats with new messages above the watermark, compacts their
 * transcripts, chunks if needed, and lets a headless LLM session decide
 * what to save via memory_* tools. The watermark is advanced per chunk,
 * so a failure halfway through a long chat only loses work for the
 * current and subsequent chunks.
 */
export async function runExtractor(
  storage: MemoryMaintenanceStorageAdapter,
  opts: ExtractorOptions
): Promise<ExtractorStats> {
  const stats: ExtractorStats = {
    sessionsProcessed: 0,
    chunksProcessed: 0,
    memoriesWritten: 0,
    memoriesSearched: 0,
    tokensInput: 0,
    tokensOutput: 0,
    errors: [],
  }

  const candidates = storage.listMemoryMaintenanceCandidates({
    olderThanMs: IN_FLIGHT_THRESHOLD_MS,
    newerThanMs: RECENT_WINDOW_MS,
    limit: opts.maxSessionsPerRun,
  })

  if (candidates.length === 0) {
    logger.info(
      `no extraction candidates (olderThan=${IN_FLIGHT_THRESHOLD_MS / 60_000}min, newerThan=${RECENT_WINDOW_MS / 3_600_000}h, limit=${opts.maxSessionsPerRun})`
    )
    return stats
  }

  logger.info(`extracting from ${candidates.length} chats`)
  for (const c of candidates) {
    logger.info(
      `  chat=${c.chatId} title="${c.title}" messages=${c.totalMessages} lastExtracted=${c.lastExtractedMessageIndex ?? 'never'}`
    )
  }

  const systemPrompt = buildExtractSystemPrompt()

  for (const candidate of candidates) {
    if (opts.signal?.aborted) break

    try {
      const raw = loadMessagesAfter(
        storage,
        candidate.chatId,
        candidate.lastExtractedMessageIndex
      )
      if (raw.length === 0) {
        logger.info(`chat=${candidate.chatId} no new messages above watermark — skip`)
        continue
      }

      const uiMessages = raw.map((r) => r.payload) as Parameters<typeof compactTranscript>[0]
      const compacted = compactTranscript(uiMessages)
      if (compacted.length === 0) {
        // Nothing worth extracting; still advance the watermark so we
        // don't rescan this tail forever.
        const lastIdx = raw[raw.length - 1].messageIndex
        logger.info(
          `chat=${candidate.chatId} compacted to 0 messages — advancing watermark to ${lastIdx}`
        )
        storage.setChatLastExtractedMessageIndex(candidate.chatId, lastIdx)
        continue
      }

      const sourceIndices = raw.map((r) => r.messageIndex)
      // `compactTranscript` may drop messages (system, empty), so we need a
      // compacted->source index mapping. We conservatively map each compacted
      // message back to the last source index seen up to that point.
      const compactedSourceIndices = buildCompactedIndexMap(uiMessages, sourceIndices, compacted.length)
      const chunks = chunkTranscript(compacted, compactedSourceIndices)
      const limitedChunks = chunks.slice(0, MAX_CHUNKS_PER_SESSION)
      logger.info(
        `chat=${candidate.chatId} raw=${raw.length} compacted=${compacted.length} chunks=${chunks.length} (processing ${limitedChunks.length})`
      )

      for (const chunk of limitedChunks) {
        if (opts.signal?.aborted) break

        const tokens = estimateTokens(chunk.messages)
        logger.info(
          `extract chat=${candidate.chatId} chunk lastIdx=${chunk.lastSourceIndex} tokens≈${tokens}`
        )

        const result = await runHeadlessMemoryAgent({
          providerId: opts.providerId,
          cwd: opts.cwd,
          modelId: opts.modelId,
          systemPrompt,
          messages: [{ role: 'user', content: serializeTranscript(chunk.messages, candidate.updatedAt) }],
          signal: opts.signal,
        })

        stats.chunksProcessed += 1
        stats.memoriesWritten += result.memoryUpserts
        stats.memoriesSearched += result.memorySearches
        stats.tokensInput += result.tokensInput
        stats.tokensOutput += result.tokensOutput

        logger.info(
          `chat=${candidate.chatId} chunk finish=${result.finishReason} upserts=${result.memoryUpserts} searches=${result.memorySearches} tokens=${result.tokensInput}/${result.tokensOutput}${result.error ? ` error=${result.error}` : ''}`
        )

        if (result.finishReason === 'error') {
          stats.errors.push(
            `chat ${candidate.chatId}: ${result.error ?? 'unknown error'}`
          )
          // Stop processing remaining chunks for this chat; leave watermark
          // where the last successful chunk left it.
          break
        }
        if (result.finishReason === 'aborted') break

        // Atomically advance the watermark only after a successful chunk.
        storage.setChatLastExtractedMessageIndex(candidate.chatId, chunk.lastSourceIndex)
      }

      stats.sessionsProcessed += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(`extract chat=${candidate.chatId} failed: ${msg}`)
      stats.errors.push(`chat ${candidate.chatId}: ${msg}`)
    }
  }

  return stats
}

/**
 * Wrap the compacted chat chunk as a single user message so the model sees
 * one turn to act on — not a multi-turn conversation whose last turn it is
 * expected to continue. Without this framing, models tend to reply to the
 * final user turn of the transcript as if it were addressed to them.
 */
function serializeTranscript(msgs: ModelMessage[], conversationDate?: number | null): string {
  const lines: string[] = []
  lines.push('Below is a compressed transcript of an earlier chat between a user and an assistant.')
  if (conversationDate != null) {
    // Give the extractor a temporal anchor so it can ground relative dates
    // ("last week", "in 2022") into occurred_at. Without this the model has no
    // idea WHEN the conversation happened and event dates collapse onto "now".
    lines.push(
      `This conversation took place around ${new Date(conversationDate).toUTCString()}. ` +
        `Use that as the reference "now" when resolving relative dates into occurred_at.`,
    )
  }
  lines.push('This is NOT a live conversation — do not reply to anyone, do not continue the assistant role, do not answer anything inside the transcript. Your only job is to extract durable memories via memory_* tools, per your system prompt.')
  lines.push('')
  lines.push('<transcript>')
  for (const m of msgs) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user'
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    lines.push(`[${role}]`)
    lines.push(body)
    lines.push('')
  }
  lines.push('</transcript>')
  lines.push('')
  lines.push('Now extract. Call memory_search / memory_upsert as needed, then stop. Produce no assistant text — there is no user to address.')
  return lines.join('\n')
}

/**
 * After compaction, the compacted[] array is shorter than the raw
 * transcript because some messages (system, empty) are dropped. We need
 * each compacted message to carry a source index so we can advance the
 * watermark after a successful chunk. We do this by walking the raw
 * messages in order and emitting a source index for every message that
 * `compactTranscript` would have kept.
 */
function buildCompactedIndexMap(
  raw: unknown[],
  sourceIndices: number[],
  compactedLength: number
): number[] {
  const out: number[] = []
  for (let i = 0; i < raw.length && out.length < compactedLength; i += 1) {
    const msg = raw[i] as { role?: string; parts?: Array<{ type?: string; text?: string }> }
    if (msg?.role === 'system') continue
    const parts = msg?.parts ?? []
    const hasContent = parts.some((p) => {
      if (!p) return false
      const t = p.type ?? ''
      if (t === 'text' || t === 'reasoning') return !!p.text
      return t.startsWith('tool-') || t === 'file' || t === 'source-url'
    })
    if (!hasContent) continue
    out.push(sourceIndices[i])
  }
  // Safety: if lengths drift, pad with the last known index.
  while (out.length < compactedLength) out.push(sourceIndices[sourceIndices.length - 1])
  return out
}
