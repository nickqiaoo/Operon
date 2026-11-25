/**
 * `runAgentTurn` — the shared, HTTP-agnostic core for running ONE agent turn on
 * a session.
 *
 * Every provider's `session.stream()` yields the same `RuntimeStreamPart`; this
 * normalizes them, renders them into the AI SDK's `UIMessageChunk`s and
 * assembles the final `UIMessage` — in ONE pipeline that the turn drives
 * itself. Nothing the caller does (or fails to do) can stall or buffer it:
 * observers get callbacks, not a stream they are obliged to drain.
 *
 *   - `onPart`  — every raw runtime part (approvals, errors, telemetry, IM relays).
 *   - `onChunk` — every UI chunk (the chat's turn stream, a run panel).
 *   - `done`    — the assembled reply (persistence, "give me the answer" callers).
 *
 * It knows nothing about chat vs workflow, HTTP, chatId, persistence, or
 * workspaceId — those are the consumers' concern. Tools/model/provider/cwd are
 * all baked into the `session` the caller passes, so this works identically for
 * custom / claude-code / codex / … .
 */

import {
  createUIMessageStream,
  type LanguageModelUsage,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamWriterWithOutcome,
} from 'ai'
import type { AgentInput, AgentSession, RuntimeStreamPart } from '@operon/agent-runtime'
import type { PreparedTextStreamPart } from './prepared-stream-parts.js'
import { buildStreamMessageMetadata } from '@operon/agent-runtime'
import { toUiMessageMetadata, type UiMessageMetadata } from './ui-metadata.js'
import { writeInjectedInput, writeMessageMetadata, writeTextStreamPart } from '@operon/agent-runtime/ai-sdk'
import { getSessionIdFromProviderMetadata } from '@operon/agent-runtime'
import { createTrafficRecorder } from '@operon/agent-runtime'
import { readStreamAsAsyncIterable } from '@operon/agent-runtime'
import { inputText } from './message-utils.js'
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
}): PreparedTextStreamPart<UiMessageMetadata> => {
  if (part.type === 'message-metadata') {
    state.hasExplicitMetadata = true
    return { metadata: toUiMessageMetadata(part.metadata) }
  }
  if (part.type === 'injected-input') return { injectedInput: part }
  if (part.type === 'finish-step' && !state.hasExplicitMetadata) {
    return {
      part,
      metadata: toUiMessageMetadata(
        buildStreamMessageMetadata({
          providerMetadata: part.providerMetadata,
          usage: part.usage,
        }),
      ),
    }
  }
  return { part }
}

/** Render a prepared part onto a UIMessageStream writer (prepared → UIMessageChunk). */
const writePreparedPartToUiStream = (
  writer: Parameters<NonNullable<Parameters<typeof createUIMessageStream>[0]['execute']>>[0]['writer'],
  preparedPart: PreparedTextStreamPart<UiMessageMetadata>,
  assistantMessageId: string,
): void => {
  if (preparedPart.part) {
    writeTextStreamPart(writer, preparedPart.part, assistantMessageId, () => preparedPart.metadata)
    return
  }
  if (preparedPart.injectedInput) {
    writeInjectedInput(writer, preparedPart.injectedInput)
    return
  }
  if (preparedPart.metadata) {
    writeMessageMetadata(writer, preparedPart.metadata)
  }
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
  /** This turn's input. The agent keeps the history; see `latestUserInput` to take it from a transcript. */
  input: AgentInput
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
   * included). Driven by the turn itself, so it keeps firing whoever is or is
   * not watching — used for the inbox's pending-approval tracking, error
   * detection, IM relays.
   */
  onPart?: (part: RuntimeStreamPart) => void
  /**
   * Every UI chunk of the reply, in order, as the turn produces it. Called
   * synchronously; a throw is logged and does not affect the turn.
   */
  onChunk?: (chunk: UIMessageChunk) => void
  /**
   * The text of the error chunk written when the stream itself fails. The SDK's
   * default hides the cause; a caller that shows the stream to a person decides
   * what may be shown.
   */
  onError?: (error: unknown) => string
  /** When set, the raw provider stream is also recorded for debugging. */
  traffic?: AgentTurnTrafficContext
  /** When true, run this turn as a goal pursuit (set active goal, stream autonomous turns). */
  asGoal?: boolean
  /**
   * Called with the reply as it stands each time a piece of it settles — a
   * block of text or reasoning closes, a tool call is made, a tool returns, an
   * approval is asked for — so the caller can save it before the turn ends.
   * Paced: at most one call per `CHECKPOINT_MIN_INTERVAL_MS`, the last boundary
   * in a burst always getting one. Return a number to ask for a longer gap
   * before the next call (e.g. the reply has grown large). Never called with
   * the final message; that is `done`.
   */
  onCheckpoint?: (message: UIMessage) => number | void
}

export interface AgentTurnResult {
  /**
   * Resolves when the turn finishes with the assembled assistant message, and
   * the error the stream failed with, if it did. Never rejects.
   */
  done: Promise<{ message: UIMessage; error?: unknown }>
}

/** Floor between two checkpoints of one turn. */
const CHECKPOINT_MIN_INTERVAL_MS = 1_000

/** Chunks after which a piece of the reply has settled and is worth saving. */
const CHECKPOINT_CHUNKS = new Set<UIMessageChunk['type']>([
  'text-end',
  'reasoning-end',
  'tool-input-available',
  'tool-input-error',
  'tool-approval-request',
  'tool-output-available',
  'tool-output-error',
  'tool-output-denied',
  'finish-step',
])

/**
 * Turns settled chunks in the assembly stream into paced `onCheckpoint` calls.
 *
 * The SDK hands over the assembled message mid-stream only at a `finish-step`
 * (`onStepEnd`), which most providers send once per turn. So this writes its own
 * `{ type: 'finish-step' }` right after a settling chunk. A finish-step changes
 * nothing in a message — the SDK's reducer treats it as a no-op on the server
 * and in the browser alike (`start-step` is what adds a step part) — and as a
 * chunk of its own it lands between two others, never inside an open part, so
 * the paced ones can ride the same stream every viewer reads. Provider
 * finish-steps are swallowed here and count as a settling chunk instead, so
 * every `onStepEnd` is one of ours and paced.
 *
 * Pacing keeps the clone + write per checkpoint off the per-chunk path: a burst
 * of tool results yields one checkpoint now and one when the gap has passed.
 */
function createCheckpointPacer(onCheckpoint: (message: UIMessage) => number | void) {
  let writer: UIMessageStreamWriterWithOutcome | undefined
  let open = true
  let lastAt = 0
  let gapMs = CHECKPOINT_MIN_INTERVAL_MS
  let timer: ReturnType<typeof setTimeout> | undefined

  const fire = (): void => {
    timer = undefined
    if (!open || !writer) return
    lastAt = Date.now()
    writer.write({ type: 'finish-step' })
  }
  const request = (): void => {
    if (!open || timer) return
    const wait = lastAt + gapMs - Date.now()
    if (wait <= 0) fire()
    else timer = setTimeout(fire, wait)
  }

  return {
    attach(target: UIMessageStreamWriterWithOutcome): UIMessageStreamWriterWithOutcome {
      writer = target
      return {
        write: (chunk) => {
          if (chunk.type === 'finish-step') {
            request()
            return
          }
          target.write(chunk)
          if (CHECKPOINT_CHUNKS.has(chunk.type)) request()
        },
        merge: (stream) => target.merge(stream),
        onError: target.onError,
        setOutcome: (outcome) => target.setOutcome(outcome),
      }
    },
    deliver(message: UIMessage): void {
      if (!open) return
      const requested = onCheckpoint(message)
      gapMs = typeof requested === 'number' ? Math.max(CHECKPOINT_MIN_INTERVAL_MS, requested) : CHECKPOINT_MIN_INTERVAL_MS
    },
    close(): void {
      open = false
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

/** The start already stamped on the reply this turn continues, if any. */
const continuedTurnStartedAt = (messages: UIMessage[], assistantMessageId: string): number | undefined => {
  const last = messages.at(-1)
  if (last?.role !== 'assistant' || last.id !== assistantMessageId) return undefined
  const value = (last.metadata as UiMessageMetadata | undefined)?.turnStartedAt
  return typeof value === 'number' ? value : undefined
}

/** Run one turn on `session` and produce the standard event stream + final message. */
export function runAgentTurn(session: AgentSession, input: AgentTurnInput): AgentTurnResult {
  const rawParts =
    input.asGoal && session.goal
      ? session.goal.run(inputText(input.input), { signal: input.signal })
      : session.send(input.input, { signal: input.signal })

  const recorder = input.traffic
    ? createTrafficRecorder({ requestId: input.requestId, ...input.traffic })
    : null
  const parts: AsyncIterable<RuntimeStreamPart> = recorder ? recorder.tee(rawParts) : rawParts

  const metaState: PreparedMetadataState = { hasExplicitMetadata: false }
  // Stamp the turn's wall-clock bounds on the reply so "Worked for 4m 47s" reads
  // the same after a reload or on another device. A continuation (the reply picked
  // up after an approval) keeps the start of the turn it continues.
  let turnStartPending = !continuedTurnStartedAt(input.originalMessages, input.assistantMessageId)
  let turnEndStamped = false
  const turnStartedAt = Date.now()
  const iterator = parts[Symbol.asyncIterator]()
  let detachHostApprovalStream: (() => void) | undefined
  let streamClosed = false

  const preparedStream = new ReadableStream<PreparedTextStreamPart<UiMessageMetadata>>({
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
        if (!turnEndStamped) controller.enqueue({ metadata: { turnEndedAt: Date.now() } })
        controller.close()
        return
      }
      const chatId = input.traffic?.chatId
      if (chatId != null && chatId > 0) {
        observeHostApprovalStreamPart(chatId, next.value)
      }
      logPart(next.value)
      input.onPart?.(next.value)
      let preparedPart = prepareTextStreamPart({ part: next.value, state: metaState })
      // The bounds ride on the reply's own `start` / `finish` chunks.
      if (next.value.type === 'start' && turnStartPending) {
        turnStartPending = false
        preparedPart = { ...preparedPart, metadata: { ...preparedPart.metadata, turnStartedAt } }
      } else if (next.value.type === 'finish') {
        turnEndStamped = true
        preparedPart = { ...preparedPart, metadata: { ...preparedPart.metadata, turnEndedAt: Date.now() } }
      }
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

  // One pipeline: prepared parts → UI chunks, assembled as they pass (onFinish /
  // onStepEnd) and handed to `onChunk`. The turn drains it itself, so `done`
  // (and persistence built on it) resolves however its observers behave.
  const done = (async (): Promise<{ message: UIMessage; error?: unknown }> => {
    let assembled: UIMessage | undefined
    let streamError: unknown
    const checkpoints = input.onCheckpoint ? createCheckpointPacer(input.onCheckpoint) : undefined
    try {
      const uiStream = createUIMessageStream({
        originalMessages: input.originalMessages,
        generateId: () => input.assistantMessageId,
        ...(input.onError ? { onError: input.onError } : {}),
        onFinish: ({ responseMessage }) => {
          assembled = responseMessage
        },
        ...(checkpoints ? { onStepEnd: ({ responseMessage }: { responseMessage: UIMessage }) => checkpoints.deliver(responseMessage) } : {}),
        execute: async ({ writer }) => {
          const target = checkpoints ? checkpoints.attach(writer) : writer
          try {
            for await (const preparedPart of readStreamAsAsyncIterable(preparedStream)) {
              writePreparedPartToUiStream(target, preparedPart, input.assistantMessageId)
            }
          } catch (error) {
            streamError = error
            throw error
          } finally {
            checkpoints?.close()
          }
        },
      })
      for await (const chunk of readStreamAsAsyncIterable(uiStream)) {
        if (!input.onChunk) continue
        try {
          input.onChunk(chunk)
        } catch (error) {
          console.warn('[AI] runAgentTurn onChunk observer failed:', error instanceof Error ? error.message : String(error))
        }
      }
    } catch (err) {
      streamError ??= err
      console.error('[AI] runAgentTurn stream error:', err)
    }
    return {
      message: assembled ?? { id: input.assistantMessageId, role: 'assistant', parts: [] },
      ...(streamError !== undefined ? { error: streamError } : {}),
    }
  })()

  return { done }
}

/** A `finish` whose reason says the turn failed (codex writes a failed turn's error as its text). */
export function isErrorFinish(reason: unknown): boolean {
  if (reason === 'error') return true
  return typeof reason === 'object' && reason != null && (reason as { unified?: unknown }).unified === 'error'
}
