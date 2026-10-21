/**
 * A sub-agent's transcript, read from the chats it ran as.
 *
 * The run panel folds an agent's work through one reducer over UI message
 * chunks (`reduceAgentChunk` on the client). Agents now run as chats, so their
 * output is the chats' stored messages — plus, while a turn is still going, what
 * that turn has streamed so far, which only the live-turn buffer holds until the
 * turn ends and its reply is saved. Both are turned back into the same chunks
 * here, so a chat-backed agent and an older recorded one render alike.
 */

import type { UIMessage } from 'ai'
import { getChatStorage } from '../ai/state.js'
import { getLiveTurn } from '../ai/live-turn-hub.js'

const INJECTED_INPUT_PART = 'data-injected-input'

interface ToolLikePart {
  type: string
  toolName?: string
  toolCallId?: string
  state?: string
  input?: unknown
}

/**
 * One chat's messages as chunks. The first user message is the agent's prompt,
 * which the panel has never shown; any later one is a person talking to it — a
 * steer while it worked, or a message after — and shows as such.
 */
export function chunksFromMessages(messages: readonly UIMessage[]): unknown[] {
  const chunks: unknown[] = []
  // A steer is stored twice: as a user message, and as a marker in the reply at
  // the point the agent took it in. The marker is where it belongs.
  const injected = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts ?? []) {
      const id = (part as { id?: unknown }).id
      if (part.type === INJECTED_INPUT_PART && typeof id === 'string') injected.add(id)
    }
  }

  let promptSeen = false
  for (const message of messages) {
    if (message.role === 'user') {
      if (!promptSeen) {
        promptSeen = true
        continue
      }
      if (injected.has(message.id)) continue
      const text = textOf(message)
      if (text) chunks.push({ type: 'data-steer', data: { text } })
      continue
    }
    if (message.role !== 'assistant') continue
    for (const part of message.parts ?? []) {
      if (part.type === 'text') {
        const text = (part as { text?: string }).text
        if (text) chunks.push({ type: 'text-delta', delta: text })
        continue
      }
      if (part.type === INJECTED_INPUT_PART) {
        const text = (part as { data?: { text?: unknown } }).data?.text
        if (typeof text === 'string' && text) chunks.push({ type: 'data-steer', data: { text } })
        continue
      }
      const tool = part as ToolLikePart
      const toolName = tool.type === 'dynamic-tool' ? tool.toolName : tool.type.startsWith('tool-') ? tool.type.slice(5) : undefined
      if (!toolName || !tool.toolCallId) continue
      chunks.push({ type: 'tool-input-available', toolCallId: tool.toolCallId, toolName, input: tool.input })
      if (tool.state === 'output-available') chunks.push({ type: 'tool-output-available', toolCallId: tool.toolCallId })
      else if (tool.state === 'output-error' || tool.state === 'output-denied') {
        chunks.push({ type: 'tool-output-error', toolCallId: tool.toolCallId })
      }
    }
  }
  return chunks
}

/** The chunks in a buffered UI message stream (`data: {…}` lines). */
export function chunksFromSse(text: string): unknown[] {
  const chunks: unknown[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const body = line.slice(5).trim()
    if (!body || body === '[DONE]') continue
    try {
      const chunk = JSON.parse(body) as { type?: string; id?: unknown; data?: { text?: unknown } }
      // The live stream marks a steer the same way the saved reply does.
      if (chunk.type === INJECTED_INPUT_PART) {
        if (typeof chunk.data?.text === 'string') chunks.push({ type: 'data-steer', data: { text: chunk.data.text } })
        continue
      }
      chunks.push(chunk)
    } catch {
      // A partial line at the end of the buffer; the next read has it whole.
    }
  }
  return chunks
}

function textOf(message: UIMessage): string {
  return (message.parts ?? [])
    .map((part) => (part.type === 'text' ? ((part as { text?: string }).text ?? '') : ''))
    .join('')
    .trim()
}

/**
 * An agent's whole transcript across its chats, oldest first. A handoff to
 * another provider started a new chat; the panel marks where.
 */
export function readAgentChatChunks(chatIds: readonly number[]): unknown[] {
  const storage = getChatStorage()
  if (!storage) return []
  const chunks: unknown[] = []
  let previousProvider: string | undefined
  for (const chatId of chatIds) {
    const entry = storage.getChatEntry(chatId)
    if (!entry) continue
    const provider = entry.providerId ?? '?'
    if (previousProvider !== undefined) chunks.push({ type: 'data-replaced', data: { from: previousProvider, to: provider } })
    previousProvider = provider
    chunks.push(...chunksFromMessages(entry.messages as UIMessage[]))
    // A turn still going has not saved its reply yet; what it has said so far is in its live buffer.
    const turn = getLiveTurn(chatId)
    if (turn && !turn.isDone) chunks.push(...chunksFromSse(turn.snapshot()))
  }
  return chunks
}
