// A reply that no `/api/ai/chat` request is waiting on.
//
// A chat's transcript is normally written by the turn the UI drove. Some turns
// start without one: an operon lead woken by a teammate's report, or Claude Code
// answering a background agent that just finished. Those are run here through
// the same pipeline as a normal reply — mapped by `runAgentTurn`, tee'd into the
// live-turn hub so an open tab renders it as it streams, and persisted onto the
// chat — so they show up exactly like one.

import { randomUUID } from 'node:crypto'
import { createUIMessageStreamResponse, type UIMessage } from 'ai'
import type { AgentSession, RuntimeStreamPart } from '@operon/agent-runtime'
import { preparedToUIChunks, runAgentTurn } from './agent-turn.js'
import { createChatResponseHeaders } from './helpers.js'
import { pumpToLiveTurn, startLiveTurn } from './live-turn-hub.js'
import { persistAssistantMessageWithRetry } from './persistence.js'
import { getChatHistoryService } from './state.js'

export interface DetachedTurnTarget {
  chatId: number
  modelId?: string
  providerId?: string
  sessionId?: string
  /** Prefix for log lines, naming who started the turn. */
  logTag: string
  onPart?: (part: RuntimeStreamPart) => void
}

/**
 * Stream `parts` to the chat's live turn and persist the reply. Resolves with the
 * persisted message, or undefined when the turn produced nothing to keep.
 */
export async function runDetachedTurn(
  target: DetachedTurnTarget,
  parts: AsyncIterable<RuntimeStreamPart>,
): Promise<UIMessage | undefined> {
  const detached: AgentSession = {
    id: undefined,
    send: async function* () {
      yield* parts
    },
    abort: () => undefined,
    close: async () => undefined,
    respond: () => false,
  }

  const assistantMessageId = randomUUID()
  // The SDK masks stream errors behind a generic notice and drops them from the
  // assembled message; a turn whose model call failed would show as an empty
  // bubble. Keep the text.
  let streamError: string | undefined
  const { preparedParts, done } = runAgentTurn(detached, {
    requestId: randomUUID(),
    input: '',
    signal: new AbortController().signal,
    assistantMessageId,
    originalMessages: [],
    onPart: (part) => {
      if (part.type === 'error') {
        const error = (part as { error?: unknown }).error
        streamError = error instanceof Error ? error.message : String(error ?? 'stream error')
      }
      target.onPart?.(part)
    },
  })

  // Same wire format as `handleChat`: an open tab attaches to the live turn and
  // the AI SDK rebuilds the assistant message from the replayed chunks.
  try {
    const response = createUIMessageStreamResponse({
      stream: preparedToUIChunks(preparedParts, assistantMessageId, []),
    })
    const headers = createChatResponseHeaders(response.headers, target.chatId)
    const turn = startLiveTurn(target.chatId, headersToRecord(headers))
    if (response.body) void pumpToLiveTurn(response.body, turn)
    else turn.finish()
  } catch (error) {
    console.warn(`[${target.logTag}] live turn tee failed:`, error instanceof Error ? error.message : String(error))
  }

  const { message } = await done
  const hasContent = message.parts.some((p) => p.type !== 'step-start')
  if (!hasContent && !streamError) return undefined
  const toPersist: UIMessage = hasContent
    ? message
    : { ...message, parts: [...message.parts, { type: 'text', text: `Error: ${streamError}` }] }
  if (streamError) console.warn(`[${target.logTag}] detached turn on chat ${target.chatId} failed: ${streamError}`)
  const meta = getChatHistoryService()?.getChatMeta(target.chatId)
  await persistAssistantMessageWithRetry({
    chatId: target.chatId,
    baseRevision: meta?.revision ?? 0,
    assistantMessage: toPersist,
    modelId: target.modelId,
    providerId: target.providerId,
    sessionId: target.sessionId,
  })
  return toPersist
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

/** The reply's text, flattened and cut for a notification body. */
export function replySnippet(message: UIMessage): string | undefined {
  const text = message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, 140) : undefined
}
