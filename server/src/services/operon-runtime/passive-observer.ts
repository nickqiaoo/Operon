import { randomUUID } from 'node:crypto'
import { createUIMessageStreamResponse, type UIMessage } from 'ai'
import type { AgentEvent, HarnessSession } from 'operon-agents'
import { PEER_SOURCE } from 'operon-agents-peers'
import type { RuntimeSession, RuntimeStreamPart } from '@operon/agent-runtime'
import { preparedToUIChunks, runAgentTurn } from '../ai/agent-turn.js'
import { createChatResponseHeaders } from '../ai/helpers.js'
import { pumpToLiveTurn, startLiveTurn } from '../ai/live-turn-hub.js'
import {
  persistAssistantMessageWithRetry,
  persistInjectedUserMessageWithRetry,
} from '../ai/persistence.js'
import { getChatHistoryService, getChatStorage, getNotificationStorage } from '../ai/state.js'
import { notify } from '../notification-service.js'
import { OperonStreamMapper } from './message-mapper.js'
import { PartQueue } from './part-queue.js'

/**
 * Turns that nobody in operon started.
 *
 * A chat's transcript is normally written by the turn the UI drove (`OperonRuntimeSession
 * .stream()` → `startChat` → persistence). Peers break that assumption: a teammate runs on
 * its own session with no UI request behind it, and a lead is WOKEN by a teammate's report
 * — a turn that starts on the lead's session while no `/api/ai/chat` request is open. Left
 * alone, both would run invisibly and never reach the chat rows that show them.
 *
 * This observer sits on every operon session's event stream and picks up exactly those
 * turns: while the UI is driving the session (`markDriven`) it stays silent; otherwise each
 * `turn.started` … `turn.ended` window is mapped through the same `OperonStreamMapper` →
 * `runAgentTurn` pipeline as a normal reply, persisted onto the chat whose `sessionId` is
 * this session, and tee'd into the live-turn hub so an open tab renders it as it streams.
 */

interface ChatRef {
  chatId: number
  workspaceId?: number
  model?: string
  title?: string
}

interface ObserveOptions {
  /** Push a `chat_complete` notification when a passive turn ends (leads, not teammates). */
  notifyOnTurnEnd?: boolean
}

interface ActiveRun {
  queue: PartQueue
  mapper: OperonStreamMapper
}

interface Observation {
  session: HarnessSession
  unsubscribe: () => void
}

// Keyed by session id but checked by INSTANCE: the peers network reopens a closed session
// (`actions.openSession` → `resumeSession`) as a new HarnessSession under the same id, and
// that new instance needs its own subscription.
const observed = new Map<string, Observation>()
const driven = new Set<string>()

/** The UI is streaming this session right now — the observer must not double-record. */
export function markDriven(sessionId: string): void {
  driven.add(sessionId)
}

export function unmarkDriven(sessionId: string): void {
  driven.delete(sessionId)
}

export function isObserved(sessionId: string): boolean {
  return observed.has(sessionId)
}

/** Stop observing (session closed / harness torn down). */
export function unobserveSession(sessionId: string): void {
  observed.get(sessionId)?.unsubscribe()
  observed.delete(sessionId)
}

let watcher: ReturnType<typeof setInterval> | undefined

/**
 * Catch sessions operon did not open itself. A teammate's report reopens a lead the UI had
 * closed (tab closed → `dispose` → `HarnessSession.close`), and a message to a parked
 * teammate reopens it — both through the peers network, with no hook back to us. Every
 * open session that has a chat row gets an observer; already-observed instances are skipped.
 */
export function startSessionWatch(harness: { readonly sessions: ReadonlyMap<string, HarnessSession> }, intervalMs = 3000): void {
  if (watcher) return
  const sweep = (): void => {
    const storage = getChatStorage()
    if (!storage) return
    for (const session of harness.sessions.values()) {
      const current = observed.get(session.id)
      if (current?.session === session) continue
      const row = storage.findChatBySessionId(session.id)
      if (!row) continue
      observeSession(session, { notifyOnTurnEnd: row.tp !== 'teammate' })
    }
  }
  watcher = setInterval(sweep, intervalMs)
  watcher.unref?.()
}

/**
 * Attach the passive observer to `session`. Idempotent per session id. The chat is
 * resolved lazily on each turn (a chat row may be created after the session opened).
 */
export function observeSession(session: HarnessSession, options: ObserveOptions = {}): void {
  const current = observed.get(session.id)
  if (current?.session === session) return
  // Same id, new instance (reopened): drop the dead subscription first.
  current?.unsubscribe()
  let run: ActiveRun | null = null

  const finishRun = (): void => {
    if (!run) return
    const current = run
    run = null
    // The mapper emits `finish` on `agent.ended`; a turn that ended some other way
    // (failed / cancelled) still needs its stream closed cleanly.
    current.queue.push({ type: 'finish', finishReason: 'stop' } as RuntimeStreamPart)
    current.queue.close()
  }

  const unsubscribe = session.onEvent((event: AgentEvent) => {
    if (driven.has(session.id)) return
    const type = event.type as string
    if (type === 'turn.started' && event.address === 'main') {
      if (run) finishRun()
      run = { queue: new PartQueue(), mapper: new OperonStreamMapper() }
      void runPassiveTurn(session, run, options)
      return
    }
    // The inbound message lands BEFORE `turn.started` (it is what starts the turn), so
    // it is recorded whether or not a run is open.
    if (type === 'message.appended' && event.address === 'main') {
      const text = transcriptUserText(event as { message?: unknown; origin?: unknown })
      if (text) {
        const chat = resolveChat(session.id)
        const from = peerSender(event as { origin?: unknown })
        if (chat) persistInjectedUserMessageWithRetry(chat.chatId, userUiMessage(text, from))
      }
      return
    }
    if (!run) return
    for (const part of run.mapper.map(event)) run.queue.push(part)
    if (type === 'turn.ended' && event.address === 'main') finishRun()
  })

  observed.set(session.id, {
    session,
    unsubscribe: () => {
      unsubscribe()
      finishRun()
    },
  })
}

function resolveChat(sessionId: string): ChatRef | undefined {
  const row = getChatStorage()?.findChatBySessionId(sessionId)
  if (!row) return undefined
  return { chatId: row.id, workspaceId: row.workspaceId, model: row.model, title: row.title }
}

async function runPassiveTurn(session: HarnessSession, run: ActiveRun, options: ObserveOptions): Promise<void> {
  const chat = resolveChat(session.id)
  if (!chat) {
    // No chat row for this session: drain so the queue never backs up.
    for await (const _ of run.queue) {
      // discard
    }
    return
  }

  const passive: RuntimeSession = {
    stream: async function* () {
      for await (const part of run.queue) yield part
    },
    abort: () => undefined,
    dispose: async () => undefined,
    resolvePermission: () => false,
  }

  const assistantMessageId = randomUUID()
  // The SDK masks stream errors behind a generic notice and drops them from the assembled
  // message; a teammate whose model call failed would show as an empty bubble. Keep the text.
  let streamError: string | undefined
  const { preparedParts, done } = runAgentTurn(passive, {
    requestId: randomUUID(),
    messages: [],
    signal: new AbortController().signal,
    assistantMessageId,
    originalMessages: [],
    onPart: (part) => {
      if (part.type === 'error') {
        const error = (part as { error?: unknown }).error
        streamError = error instanceof Error ? error.message : String(error ?? 'stream error')
      }
    },
  })

  // Same wire format as `handleChat`: an open tab attaches to the live turn and the AI
  // SDK rebuilds the assistant message from the replayed chunks.
  try {
    const response = createUIMessageStreamResponse({
      stream: preparedToUIChunks(preparedParts, assistantMessageId, []),
    })
    const headers = createChatResponseHeaders(response.headers, chat.chatId)
    const turn = startLiveTurn(chat.chatId, headersToRecord(headers))
    if (response.body) void pumpToLiveTurn(response.body, turn)
    else turn.finish()
  } catch (error) {
    console.warn('[operon.peers] live turn tee failed:', error instanceof Error ? error.message : String(error))
  }

  const { message } = await done
  const hasContent = message.parts.some((p) => p.type !== 'step-start')
  if (!hasContent && !streamError) return
  const toPersist: UIMessage = hasContent
    ? message
    : { ...message, parts: [...message.parts, { type: 'text', text: `Error: ${streamError}` }] }
  if (streamError) console.warn(`[operon.peers] passive turn on chat ${chat.chatId} (session ${session.id}) failed: ${streamError}`)
  const meta = getChatHistoryService()?.getChatMeta(chat.chatId)
  await persistAssistantMessageWithRetry({
    chatId: chat.chatId,
    baseRevision: meta?.revision ?? 0,
    assistantMessage: toPersist,
    modelId: chat.model,
    providerId: 'custom',
    sessionId: session.id,
  })

  if (options.notifyOnTurnEnd) {
    const storage = getNotificationStorage()
    if (storage) {
      notify(storage, {
        kind: 'chat_complete',
        severity: 'info',
        sourceKey: `chat:${chat.chatId}`,
        chatId: chat.chatId,
        workspaceId: chat.workspaceId ?? null,
        title: chat.title?.trim() || 'Workspace chat',
        body: snippet(message) ?? 'A teammate reported back',
      })
    }
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function snippet(message: UIMessage): string | undefined {
  const text = message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, 140) : undefined
}

function userUiMessage(text: string, peerFrom?: string): UIMessage {
  return {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
    // A peer delivery is a user-role message only because that is how it reaches the
    // model. The stamp lets the UI render it as what it is — another agent talking —
    // instead of as something this user typed.
    ...(peerFrom ? { metadata: { peer: { from: peerFrom } } } : {}),
  }
}

/**
 * The sender's name when this `message.appended` carries a peer delivery, as the RECIPIENT
 * knows it (`lead`, `dba`) — the framework resolves the roster id to that name before it
 * ever reaches the journal (see `PeerNetwork.deliver`).
 */
export function peerSender(event: { origin?: unknown }): string | undefined {
  const origin = event.origin as { kind?: unknown; source?: unknown; actor?: unknown } | undefined
  if (origin?.kind !== 'external' || origin.source !== PEER_SOURCE) return undefined
  return typeof origin.actor === 'string' ? origin.actor.trim() || undefined : undefined
}

/** Prompt origins that are plumbing, not conversation — never shown as a user turn. */
const HIDDEN_ORIGINS = new Set(['injection', 'compaction_summary', 'handoff_seed'])

/**
 * The user-visible text of a `message.appended` event, or undefined when it is not a
 * user-role message worth a transcript row (assistant messages, skill/todo injections,
 * compaction summaries). A peer message arrives wrapped as
 * `<external-message source="peer" …>…</external-message>`; the wrapper is dropped so
 * the bubble reads as the message itself.
 */
export function transcriptUserText(event: { message?: unknown; origin?: unknown }): string | undefined {
  const origin = event.origin as { kind?: unknown } | undefined
  if (typeof origin?.kind === 'string' && HIDDEN_ORIGINS.has(origin.kind)) return undefined
  const text = userMessageText(event.message)
  if (!text) return undefined
  if (/^<system-reminder>/i.test(text)) return undefined
  const unwrapped = text
    .replace(/^<external-message\b[^>]*>\s*/i, '')
    .replace(/\s*<\/external-message>\s*$/i, '')
    // The framework's "not from the user" preamble is for the model, not the reader.
    .replace(/^\[system: automated event[^\]]*\]\s*/i, '')
    .trim()
  return unwrapped || undefined
}

/** Text of a `message.appended` payload when it is a user-role message; else undefined. */
function userMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const m = message as { role?: unknown; content?: unknown }
  if (m.role !== 'user') return undefined
  if (typeof m.content === 'string') return m.content.trim() || undefined
  if (Array.isArray(m.content)) {
    const text = m.content
      .map((p) => (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('\n')
      .trim()
    return text || undefined
  }
  return undefined
}
