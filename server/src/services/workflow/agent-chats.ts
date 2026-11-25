/**
 * A sub-agent's transcript, read from the chats it ran as.
 *
 * The run panel folds an agent's work through one reducer over UI message
 * chunks (`reduceAgentChunk` on the client). Agents now run as chats, so their
 * output is the chats' stored messages — except that, while a turn is still
 * going, its reply comes from the turn stream: the stored copy is only its
 * last checkpoint. Both are turned back into the same chunks
 * here, so a chat-backed agent and an older recorded one render alike.
 */

import type { UIMessage } from 'ai'
import { getChatStorage } from '../ai/state.js'
import { getChatTurnStream } from '../ai/chat-turn-lifecycle.js'

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
        const data = (part as { data?: { text?: unknown; notice?: unknown } }).data
        // An automated notice is not a steer anyone sent.
        if (data?.notice !== true && typeof data?.text === 'string' && data.text) chunks.push({ type: 'data-steer', data: { text: data.text } })
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

/** A turn stream's chunks (the reply so far), as the run panel shows them. */
export function chunksFromStream(chunks: readonly unknown[]): unknown[] {
  const out: unknown[] = []
  for (const value of chunks) {
    const chunk = value as { type?: string; data?: { text?: unknown; notice?: unknown } }
    // The stream marks a steer the same way the saved reply does.
    if (chunk.type === INJECTED_INPUT_PART) {
      if (chunk.data?.notice !== true && typeof chunk.data?.text === 'string') out.push({ type: 'data-steer', data: { text: chunk.data.text } })
      continue
    }
    out.push(chunk)
  }
  return out
}

/**
 * The stored messages a running turn's stream already covers: its reply (the
 * stream stands in for the saved checkpoint) and, for a `settled` reader that
 * renders the stream itself, the steers sent into it. A steer is stored just
 * before the reply it went into, and the stream marks where the agent took it
 * in; left in, it would show twice.
 */
function runningTurnMessages(messages: readonly UIMessage[], replyId: string, settled: boolean): Set<string> {
  const ids = new Set([replyId])
  if (!settled) return ids
  const index = messages.findIndex((m) => m.id === replyId)
  for (let i = index - 1; i >= 0; i -= 1) {
    const metadata = messages[i]?.metadata as { steer?: unknown } | undefined
    if (messages[i]?.role !== 'user' || metadata?.steer !== true) break
    ids.add(messages[i]!.id)
  }
  for (const message of messages) {
    const metadata = message.metadata as { steer?: unknown; turnMessageId?: unknown } | undefined
    if (message.role === 'user' && metadata?.steer === true && metadata.turnMessageId === replyId) ids.add(message.id)
  }
  return ids
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
 *
 * `settled` leaves a running turn out entirely (its saved checkpoint too): the
 * reader is watching that turn on the chat's stream.
 */
export function readAgentChatChunks(chatIds: readonly number[], options: { settled?: boolean } = {}): unknown[] {
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
    // A turn still going has said more in its stream than its last saved
    // checkpoint of the reply, so the stream stands in for that message.
    const stream = getChatTurnStream(chatId)
    const running = stream && !stream.isDone ? stream : undefined
    const messages = entry.messages as UIMessage[]
    const leftOut = running?.messageId ? runningTurnMessages(messages, running.messageId, options.settled === true) : undefined
    chunks.push(...chunksFromMessages(leftOut ? messages.filter((m) => !leftOut.has(m.id)) : messages))
    if (running && !options.settled) chunks.push(...chunksFromStream(running.snapshotChunks()))
  }
  return chunks
}
