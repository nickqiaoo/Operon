/**
 * `runAgentTurn` — the shared, HTTP-agnostic core for running ONE agent turn on
 * a session and producing a standard event stream.
 *
 * Every provider's `session.stream()` yields the same `RuntimeStreamPart`; this
 * normalizes that into `PreparedTextStreamPart` (the existing shared currency —
 * already consumed by chat-flow, cronjob, canvas-workflow, mobile) and assembles
 * the final `UIMessage`. It knows nothing about chat vs workflow, HTTP, chatId,
 * persistence, or workspaceId — those are the consumers' concern:
 *
 *   - chat (`startChat`): preparedParts → SSE; done → revision-aware persist.
 *   - workflow agent:     preparedParts → hub (tagged); done → persist subagent chat.
 *
 * Tools/model/provider/cwd are all baked into the `session` the caller passes,
 * so this works identically for custom / claude-code / codex / gemini / … .
 */

import {
  createUIMessageStream,
  type LanguageModelUsage,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import type { RuntimeSession, RuntimeStreamPart } from '@operon/agent-runtime'
import type { PreparedTextStreamPart } from './prepared-stream-parts.js'
import { buildStreamMessageMetadata, type StreamMessageMetadata } from '@operon/agent-runtime'
import { writeMessageMetadata, writeTextStreamPart } from './text-stream-part-to-ui.js'
import { getSessionIdFromProviderMetadata } from '@operon/agent-runtime'
import { createTrafficRecorder } from '@operon/agent-runtime'
import { readStreamAsAsyncIterable } from '@operon/agent-runtime'
import { extractAssistantText } from './message-utils.js'
import {
  attachHostApprovalStream,
  observeHostApprovalStreamPart,
} from './host-approval-broker.js'

interface PreparedMetadataState {
  hasExplicitMetadata: boolean
}

// Opt-in part-stream diagnostics (OPERON_STREAM_DEBUG=1). Logs every RuntimeStreamPart the
// assembly actually consumes — type, tool id, and the operon nesting tag — so a tool result
// or input that arrives without a matching tool-call (the "No tool invocation found" crash)
// is visible at the exact consumer that throws.
const partDebugEnabled = (): boolean => {
  const v = process.env.OPERON_STREAM_DEBUG
  return v === '1' || v === 'true' || v === 'yes'
}
const partId = (p: RuntimeStreamPart): string => {
  const r = p as Record<string, unknown>
  if (typeof r.toolCallId === 'string') return r.toolCallId
  if (typeof r.id === 'string') return r.id
  const tc = r.toolCall as { toolCallId?: string } | undefined
  return tc?.toolCallId ?? ''
}
const logPart = (p: RuntimeStreamPart): void => {
  if (!partDebugEnabled()) return
  const parent = (p as { providerMetadata?: { operon?: { parentToolCallId?: string } } })
    .providerMetadata?.operon?.parentToolCallId
  console.error(`[part] ${p.type} id=${JSON.stringify(partId(p))}${parent ? ` parent=${JSON.stringify(parent)}` : ''}`)
}

/** Normalize one runtime part into a prepared part (carrying message metadata). */
const prepareTextStreamPart = ({
  part,
  state,
}: {
  part: RuntimeStreamPart
  state: PreparedMetadataState
}): PreparedTextStreamPart<StreamMessageMetadata> => {
  if (part.type === 'message-metadata') {
    state.hasExplicitMetadata = true
    return { metadata: part.metadata as StreamMessageMetadata }
  }
  if (part.type === 'finish-step' && !state.hasExplicitMetadata) {
    return {
      part,
      metadata: buildStreamMessageMetadata({
        providerMetadata: part.providerMetadata,
        usage: part.usage,
      }),
    }
  }
  return { part }
}

/** Render a prepared part onto a UIMessageStream writer (prepared → UIMessageChunk). */
export const writePreparedPartToUiStream = (
  writer: Parameters<NonNullable<Parameters<typeof createUIMessageStream>[0]['execute']>>[0]['writer'],
  preparedPart: PreparedTextStreamPart<StreamMessageMetadata>,
  assistantMessageId: string,
): void => {
  if (preparedPart.part) {
    writeTextStreamPart(writer, preparedPart.part, assistantMessageId, () => preparedPart.metadata)
    return
  }
  if (preparedPart.metadata) {
    writeMessageMetadata(writer, preparedPart.metadata)
  }
}

/**
 * Render the normalized prepared-part stream (`runAgentTurn`'s `preparedParts`)
 * into the AI-SDK `UIMessageChunk` stream that consumers pipe to SSE or a run
 * hub. Shared by every caller that needs UI chunks rather than the assembled
 * message (workflow subagent hub, custom worker pool, …). `onError`, when
 * provided, surfaces the real stream error in the emitted error chunk (the SDK
 * otherwise replaces it with a generic message).
 */
export function preparedToUIChunks(
  preparedParts: ReadableStream<PreparedTextStreamPart<StreamMessageMetadata>>,
  assistantMessageId: string,
  originalMessages: UIMessage[] = [],
  onError?: (error: unknown) => string,
): ReadableStream<UIMessageChunk> {
  return createUIMessageStream({
    originalMessages,
    generateId: () => assistantMessageId,
    ...(onError ? { onError } : {}),
    execute: async ({ writer }) => {
      for await (const preparedPart of readStreamAsAsyncIterable(preparedParts)) {
        writePreparedPartToUiStream(writer, preparedPart, assistantMessageId)
      }
    },
  })
}

export interface AgentTurnTrafficContext {
  chatId: number
  providerId: string
  modelId?: string
  modeId?: string
  cwd: string
}

export interface AgentTurnInput {
  requestId: string
  /** Model-ready messages (already converted from UI messages). */
  messages: ModelMessage[]
  signal: AbortSignal
  assistantMessageId: string
  /** Prior UI messages — context for assembling the response message. */
  originalMessages: UIMessage[]
  /** Called whenever the provider surfaces a session id (thread/process id). */
  onSessionId?: (sessionId: string) => void
  /**
   * Called with each PER-CALL usage sample the provider surfaces (one per LLM API call,
   * from `message-metadata` or a `finish-step`). Provider-agnostic — used for prompt-cache
   * monitoring. Fires once per part (the source `pull` runs once per chunk before the tee).
   */
  onUsage?: (usage: LanguageModelUsage) => void
  /**
   * Observe every raw stream part server-side (host-injected approval parts
   * included). Driven by the assembly branch, so it keeps firing after the SSE
   * client disconnects — used for the inbox's pending-approval tracking.
   */
  onPart?: (part: RuntimeStreamPart) => void
  /** When set, the raw provider stream is also recorded for debugging. */
  traffic?: AgentTurnTrafficContext
  /** When true, run this turn as a goal pursuit (set active goal, stream autonomous turns). */
  asGoal?: boolean
}

export interface AgentTurnResult {
  /** Standard event stream — normalized, provider-agnostic. Consumer renders it. */
  preparedParts: ReadableStream<PreparedTextStreamPart<StreamMessageMetadata>>
  /** Resolves when the turn finishes with the assembled assistant message. */
  done: Promise<{ message: UIMessage }>
}

/** Run one turn on `session` and produce the standard event stream + final message. */
export function runAgentTurn(session: RuntimeSession, input: AgentTurnInput): AgentTurnResult {
  const rawParts = session.stream({
    requestId: input.requestId,
    messages: input.messages,
    signal: input.signal,
    asGoal: input.asGoal,
  })

  const recorder = input.traffic
    ? createTrafficRecorder({ requestId: input.requestId, ...input.traffic })
    : null
  const parts: AsyncIterable<RuntimeStreamPart> = recorder ? recorder.tee(rawParts) : rawParts

  const metaState: PreparedMetadataState = { hasExplicitMetadata: false }
  const iterator = parts[Symbol.asyncIterator]()
  let detachHostApprovalStream: (() => void) | undefined
  let streamClosed = false

  const preparedStream = new ReadableStream<PreparedTextStreamPart<StreamMessageMetadata>>({
    start(controller) {
      const chatId = input.traffic?.chatId
      if (chatId == null || chatId <= 0) return
      detachHostApprovalStream = attachHostApprovalStream(chatId, (part) => {
        if (streamClosed) return
        logPart(part)
        input.onPart?.(part)
        controller.enqueue(prepareTextStreamPart({ part, state: metaState }))
      })
    },
    async pull(controller) {
      let next: IteratorResult<RuntimeStreamPart>
      try {
        next = await iterator.next()
      } catch (error) {
        streamClosed = true
        detachHostApprovalStream?.()
        throw error
      }
      if (next.done) {
        streamClosed = true
        detachHostApprovalStream?.()
        controller.close()
        return
      }
      const chatId = input.traffic?.chatId
      if (chatId != null && chatId > 0) {
        observeHostApprovalStreamPart(chatId, next.value)
      }
      logPart(next.value)
      input.onPart?.(next.value)
      const preparedPart = prepareTextStreamPart({ part: next.value, state: metaState })
      if (preparedPart.metadata?.usage) input.onUsage?.(preparedPart.metadata.usage)
      const sessionId = 'providerMetadata' in next.value
        ? getSessionIdFromProviderMetadata(next.value.providerMetadata)
        : undefined
      if (sessionId) input.onSessionId?.(sessionId)
      controller.enqueue(preparedPart)
    },
    async cancel(reason) {
      streamClosed = true
      detachHostApprovalStream?.()
      if (typeof iterator.return === 'function') {
        await iterator.return(reason)
      }
    },
  })

  // One branch goes to the consumer (preparedParts); the other is drained here to
  // assemble the final message — independent of whether the consumer reads, so
  // `done` (and persistence built on it) resolves even if the client disconnects.
  const [preparedParts, assemblyParts] = preparedStream.tee()

  const done = (async (): Promise<{ message: UIMessage }> => {
    let assembled: UIMessage | undefined
    try {
      const assemblyStream = createUIMessageStream({
        originalMessages: input.originalMessages,
        generateId: () => input.assistantMessageId,
        onFinish: ({ responseMessage }) => {
          assembled = responseMessage
        },
        execute: async ({ writer }) => {
          for await (const preparedPart of readStreamAsAsyncIterable(assemblyParts)) {
            writePreparedPartToUiStream(writer, preparedPart, input.assistantMessageId)
          }
        },
      })
      for await (const _ of readStreamAsAsyncIterable(assemblyStream)) {
        // drain so the SDK's onFinish fires with the assembled message
      }
    } catch (err) {
      console.error('[AI] runAgentTurn assembly error:', err)
    }
    return { message: assembled ?? { id: input.assistantMessageId, role: 'assistant', parts: [] } }
  })()

  return { preparedParts, done }
}

/**
 * Run one turn and resolve ONLY the final assistant text — the one true "give me the
 * result" path.
 *
 * `runAgentTurn` drains the assembly branch internally, so `done` resolves with the
 * complete message whether or not the live stream is consumed. Callers that just want
 * the answer must NOT hand-roll delta accumulation off `preparedParts` — it is easy to
 * read the wrong field and silently get `""` (the workflow sub-agent dispatch did
 * exactly that). This helper takes the text from the assembled message via
 * `extractAssistantText`, still drains the consumer branch so the tee doesn't buffer,
 * and turns a stream error into a throw so a failed turn surfaces instead of looking
 * like an empty success.
 */
export async function runAgentTurnText(
  session: RuntimeSession,
  input: AgentTurnInput,
  /**
   * Receives the turn's UI chunks as they arrive, for callers that want to SHOW
   * the work as well as use its result — a workflow sub-agent streaming into the
   * run panel, say. Omit it and the consumer branch is only scanned for errors,
   * which is all a caller that just wants the answer has to pay for.
   */
  onChunk?: (chunk: UIMessageChunk) => void,
): Promise<string> {
  const { preparedParts, done } = runAgentTurn(session, input)
  let streamError: string | undefined
  const noteError = (error: unknown): string => {
    streamError = error instanceof Error ? error.message : String(error ?? 'stream error')
    return streamError
  }
  const drained = (async () => {
    try {
      if (onChunk) {
        // Same normalization the chat path uses, so a sub-agent's stream renders
        // with the existing chunk reducers instead of a second bespoke format.
        const chunks = preparedToUIChunks(preparedParts, input.assistantMessageId, input.originalMessages, noteError)
        for await (const chunk of readStreamAsAsyncIterable(chunks)) {
          onChunk(chunk)
        }
        return
      }
      for await (const prepared of readStreamAsAsyncIterable(preparedParts)) {
        const part = (prepared as { part?: { type?: string; error?: unknown } }).part
        if (part?.type === 'error') noteError(part.error)
      }
    } catch (err) {
      noteError(err)
    }
  })()
  const { message } = await done
  await drained
  if (streamError) throw new Error(streamError)
  return extractAssistantText(message)
}
