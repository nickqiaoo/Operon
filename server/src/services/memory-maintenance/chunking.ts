import type { ModelMessage } from 'ai'
import { estimateTokens } from './compactor.js'

export const CHUNK_TARGET_TOKENS = 80_000
export const CHUNK_OVERLAP_TOKENS = 5_000

export interface TranscriptChunk {
  messages: ModelMessage[]
  lastSourceIndex: number
}

/**
 * Split a compacted transcript into chunks of roughly CHUNK_TARGET_TOKENS
 * with CHUNK_OVERLAP_TOKENS of tail carry-over between adjacent chunks.
 *
 * `sourceIndices[i]` is the chat_messages.message_index corresponding to
 * `messages[i]`. The caller uses `lastSourceIndex` to advance the
 * per-chat watermark only for chunks that completed successfully.
 */
export function chunkTranscript(
  messages: ModelMessage[],
  sourceIndices: number[]
): TranscriptChunk[] {
  if (messages.length === 0) return []
  if (messages.length !== sourceIndices.length) {
    throw new Error('chunkTranscript: messages and sourceIndices length mismatch')
  }

  const total = estimateTokens(messages)
  if (total <= CHUNK_TARGET_TOKENS) {
    return [{ messages, lastSourceIndex: sourceIndices[sourceIndices.length - 1] }]
  }

  const chunks: TranscriptChunk[] = []
  let start = 0
  while (start < messages.length) {
    let end = start
    let tokens = 0
    while (end < messages.length && tokens < CHUNK_TARGET_TOKENS) {
      tokens += estimateTokens([messages[end]])
      end += 1
    }

    const slice = messages.slice(start, end)
    chunks.push({
      messages: slice,
      lastSourceIndex: sourceIndices[end - 1],
    })

    if (end >= messages.length) break

    // Back up to create overlap for the next chunk.
    let overlapStart = end
    let overlapTokens = 0
    while (overlapStart > start && overlapTokens < CHUNK_OVERLAP_TOKENS) {
      overlapStart -= 1
      overlapTokens += estimateTokens([messages[overlapStart]])
    }
    start = overlapStart === start ? end : overlapStart
  }

  return chunks
}
