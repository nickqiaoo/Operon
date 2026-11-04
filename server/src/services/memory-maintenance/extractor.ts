import type { ModelMessage } from 'ai'
import type { MemoryMaintenanceStorageAdapter } from '../../storage/interface.js'
import { createMaintenanceLogger } from './logger.js'
import { loadMessagesAfter } from './transcript.js'
import { compactTranscript, estimateTokens } from './compactor.js'
import { chunkTranscript, type TranscriptChunk } from './chunking.js'
import { buildExtractSystemPrompt } from './prompt.js'
import { runHeadlessMemoryAgent, type HeadlessRunParams, type HeadlessRunResult } from './headless.js'
import { setExtractionSource } from './extraction-source.js'
import { isAssistantMessageRunning } from '../ai/persistence.js'
import { MemoryService } from '../memory/index.js'

const logger = createMaintenanceLogger('memory-extractor')

const IN_FLIGHT_THRESHOLD_MS = 2 * 60 * 60_000 // skip chats still active in last 2h
// Only consider chats updated within this window. The per-chat watermark already
// makes re-reading free, so the window only bounds the first pass after memory is
// switched on. It must stay well over the daily schedule plus IN_FLIGHT_THRESHOLD:
// at 24h, a chat last touched in the 2h before a run was too fresh for that run
// and already too old for the next one, so its tail was never extracted.
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000
const MAX_CHUNKS_PER_SESSION = 10
/** Entries read from the assistant's thread per run; the rest waits for the next run. */
const ASSISTANT_ENTRY_LIMIT = 2_000

export interface ExtractorOptions {
  providerId: string
  modelId?: string
  cwd: string
  maxSessionsPerRun: number
  /**
   * Evaluation mode: extract exactly these chats, each from its first message,
   * ignoring the activity window and the in-flight margin, and leave every
   * watermark where it is so the same set can be re-run. The assistant thread
   * is skipped.
   */
  evalChatIds?: number[]
  signal?: AbortSignal
}

export interface ExtractorStats {
  sessionsProcessed: number
  chunksProcessed: number
  memoriesWritten: number
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
    errors: [],
  }

  const systemPrompt = buildExtractSystemPrompt()

  const evalMode = opts.evalChatIds !== undefined
  const candidates = storage.listMemoryMaintenanceCandidates({
    olderThanMs: IN_FLIGHT_THRESHOLD_MS,
    newerThanMs: RECENT_WINDOW_MS,
    limit: evalMode ? opts.evalChatIds!.length : opts.maxSessionsPerRun,
    chatIds: opts.evalChatIds,
  })

  if (evalMode) {
    logger.info(`EVAL MODE — chats ${opts.evalChatIds!.join(',')}: read from the start, watermarks untouched, assistant thread skipped`)
    const found = new Set(candidates.map((c) => c.chatId))
    const missing = opts.evalChatIds!.filter((id) => !found.has(id))
    if (missing.length > 0) logger.warn(`eval chats not found: ${missing.join(',')}`)
  }

  if (candidates.length === 0) {
    if (evalMode) return stats
    logger.info(
      `no extraction candidates (olderThan=${IN_FLIGHT_THRESHOLD_MS / 60_000}min, newerThan=${RECENT_WINDOW_MS / 3_600_000}h, limit=${opts.maxSessionsPerRun})`
    )
    await extractAssistantThread(storage, opts, stats, systemPrompt)
    return stats
  }

  logger.info(`extracting from ${candidates.length} chats`)
  for (const c of candidates) {
    logger.info(
      `  chat=${c.chatId} title="${c.title}" messages=${c.totalMessages} lastExtracted=${c.lastExtractedMessageIndex ?? 'never'}`
    )
  }

  for (const candidate of candidates) {
    if (opts.signal?.aborted) break
    // A turn saves its reply as it goes and keeps rewriting it in place, at the
    // same index. Reading it now would move the watermark past a reply that is
    // not finished, and the rest of it would never be read. A turn idle past
    // the 2h threshold (waiting on an approval) still has one running.
    if (isAssistantMessageRunning(candidate.chatId)) {
      logger.info(`chat=${candidate.chatId} has a turn still running — skip`)
      continue
    }

    try {
      const raw = loadMessagesAfter(
        storage,
        candidate.chatId,
        evalMode ? null : candidate.lastExtractedMessageIndex
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
        if (!evalMode) storage.setChatLastExtractedMessageIndex(candidate.chatId, lastIdx)
        continue
      }

      const chunks = chunkTranscript(
        compacted.map((c) => c.message),
        compacted.map((c) => raw[c.sourcePosition].messageIndex)
      )
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

        const { result, written } = await extractChunk(`chat:${candidate.chatId}`, {
          providerId: opts.providerId,
          cwd: opts.cwd,
          modelId: opts.modelId,
          systemPrompt,
          messages: [
            {
              role: 'user',
              content: serializeTranscript(chunk, {
                conversationDate: candidate.updatedAt,
                title: candidate.title,
                projectName: candidate.projectName,
                workspacePath: candidate.workspacePath,
              }),
            },
          ],
          signal: opts.signal,
        })

        stats.chunksProcessed += 1
        stats.memoriesWritten += written

        logger.info(
          `chat=${candidate.chatId} chunk finish=${result.finishReason} written=${written}${result.error ? ` error=${result.error}` : ''}`
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
        if (!evalMode) storage.setChatLastExtractedMessageIndex(candidate.chatId, chunk.lastSourceIndex)
      }

      stats.sessionsProcessed += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(`extract chat=${candidate.chatId} failed: ${msg}`)
      stats.errors.push(`chat ${candidate.chatId}: ${msg}`)
    }
  }

  if (!evalMode) await extractAssistantThread(storage, opts, stats, systemPrompt)
  return stats
}

/**
 * The personal assistant's thread is one long conversation, not a chat with message indices: it
 * is read by time, from a watermark, up to the same in-flight margin chats get — the user's
 * words plus what finished tasks produced (docs/assistant/design.md §5).
 */
async function extractAssistantThread(
  storage: MemoryMaintenanceStorageAdapter,
  opts: ExtractorOptions,
  stats: ExtractorStats,
  systemPrompt: string
): Promise<void> {
  if (opts.signal?.aborted) return
  const after = storage.getAssistantExtractedUntil() ?? 0
  const before = Date.now() - IN_FLIGHT_THRESHOLD_MS
  if (before <= after) return
  const entries = storage.listAssistantTranscript({ after, before, limit: ASSISTANT_ENTRY_LIMIT })
  if (entries.length === 0) return
  if (!entries.some((e) => e.role === 'user')) {
    // Only the assistant talking (heartbeat notes, task results nobody followed up): move on.
    storage.setAssistantExtractedUntil(entries[entries.length - 1].at)
    return
  }
  const messages: ModelMessage[] = entries.map((e) => ({ role: e.role, content: e.text }))
  const chunks = chunkTranscript(messages, entries.map((e) => e.at)).slice(0, MAX_CHUNKS_PER_SESSION)
  logger.info(`assistant thread entries=${entries.length} chunks=${chunks.length} after=${new Date(after).toISOString()}`)
  try {
    for (const chunk of chunks) {
      if (opts.signal?.aborted) break
      const { result, written } = await extractChunk('assistant', {
        providerId: opts.providerId,
        cwd: opts.cwd,
        modelId: opts.modelId,
        systemPrompt,
        messages: [
          {
            role: 'user',
            content: serializeTranscript(chunk, {
              conversationDate: chunk.lastSourceIndex,
              title: 'Personal assistant thread',
            }),
          },
        ],
        signal: opts.signal,
      })
      stats.chunksProcessed += 1
      stats.memoriesWritten += written
      logger.info(
        `assistant thread chunk until=${new Date(chunk.lastSourceIndex).toISOString()} finish=${result.finishReason} written=${written}${result.error ? ` error=${result.error}` : ''}`
      )
      if (result.finishReason === 'error') {
        stats.errors.push(`assistant thread: ${result.error ?? 'unknown error'}`)
        break
      }
      if (result.finishReason === 'aborted') break
      storage.setAssistantExtractedUntil(chunk.lastSourceIndex)
    }
    stats.sessionsProcessed += 1
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`extract assistant thread failed: ${msg}`)
    stats.errors.push(`assistant thread: ${msg}`)
  }
}

/**
 * Run one chunk with `source` registered as the conversation being read (the
 * memory MCP route tags the extractor's writes with it), then count what the
 * chunk wrote from the timeline: every successful write — create or merge —
 * inserts exactly one entry. Never inferred from the tool stream: providers name
 * MCP tools differently and some report no tool result at all.
 */
async function extractChunk(
  source: string,
  params: HeadlessRunParams
): Promise<{ result: HeadlessRunResult; written: number }> {
  const startedAt = Date.now()
  setExtractionSource(source)
  try {
    const result = await runHeadlessMemoryAgent(params)
    return { result, written: countWrites(source, startedAt) }
  } finally {
    setExtractionSource(null)
  }
}

function countWrites(source: string, since: number): number {
  try {
    return MemoryService.getInstance().getEngine().countTimelineEntries({ source, since })
  } catch {
    // No memory service means the memory MCP server could not have written either.
    return 0
  }
}

interface TranscriptContext {
  /** Reference "now" for resolving relative dates (epoch ms). */
  conversationDate?: number | null
  title?: string
  projectName?: string
  workspacePath?: string
}

/**
 * Wrap the compacted chat chunk as a single user message so the model sees
 * one turn to act on — not a multi-turn conversation whose last turn it is
 * expected to continue. Without this framing, models tend to reply to the
 * final user turn of the transcript as if it were addressed to them.
 */
function serializeTranscript(chunk: TranscriptChunk, ctx: TranscriptContext): string {
  const lines: string[] = []
  lines.push('Below is a compressed transcript of an earlier chat between a user and an assistant.')
  if (ctx.title) lines.push(`Chat title: ${ctx.title}`)
  if (ctx.workspacePath) {
    // Tells the extractor this was work inside a code repository, which is where
    // that work's implementation details already live (see "Coding sessions").
    lines.push(
      `It ran inside the code repository of project "${ctx.projectName ?? 'unknown'}" at ${ctx.workspacePath}.`
    )
  }
  if (ctx.conversationDate != null) {
    // Give the extractor a temporal anchor so it can ground relative dates
    // ("last week", "in 2022") into occurred_at. Without this the model has no
    // idea WHEN the conversation happened and event dates collapse onto "now".
    lines.push(
      `This conversation took place around ${new Date(ctx.conversationDate).toUTCString()}. ` +
        `Use that as the reference "now" when resolving relative dates into occurred_at.`,
    )
  }
  lines.push('This is NOT a live conversation — do not reply to anyone, do not continue the assistant role, do not answer anything inside the transcript. Your only job is to extract durable memories via memory_* tools, per your system prompt.')
  lines.push('')
  lines.push('<transcript>')
  chunk.messages.forEach((m, i) => {
    if (chunk.overlap > 0 && i === 0) {
      lines.push('<already_extracted>')
      lines.push('(Context only: the messages up to </already_extracted> were extracted in an earlier pass. Do not write memories from them again.)')
      lines.push('')
    }
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user'
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    lines.push(`[${role}]`)
    lines.push(body)
    lines.push('')
    if (chunk.overlap > 0 && i === chunk.overlap - 1) {
      lines.push('</already_extracted>')
      lines.push('')
    }
  })
  lines.push('</transcript>')
  lines.push('')
  lines.push('Now extract. Call memory_search / memory_upsert as needed, then stop. Produce no assistant text — there is no user to address.')
  return lines.join('\n')
}
