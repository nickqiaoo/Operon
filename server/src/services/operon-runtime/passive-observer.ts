import { randomUUID } from 'node:crypto'
import type { UIMessage } from 'ai'
import type { AgentEvent, ApprovalResponse, HarnessSession, QuestionResult } from 'operon-agents'
import { PEER_SOURCE } from 'operon-agents-peers'
import type { PermissionDecision, RuntimeStreamPart } from '@operon/agent-runtime'
import { observePendingInputPart } from '../ai/chat-pending-input.js'
import { replySnippet, runDetachedTurn } from '../ai/detached-turn.js'
import { persistInjectedUserMessage } from '../ai/persistence.js'
import { getChatStorage, getNotificationStorage } from '../ai/state.js'
import { notify } from '../notification-service.js'
import { answerPending, cancelPending, interactiveHandlers } from './interactive-handlers.js'
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
 *
 * Such a turn can stop for an approval or a question like any other. The harness only asks a
 * live handler, and the UI-driven turn removes its own when it ends, so a passive turn
 * registers its own for as long as it runs; without one the harness parks the run durably
 * (`turn.paused`), where nothing in operon shows or answers it.
 */

interface ChatRef {
  chatId: number
  workspaceId?: number
  model?: string
  title?: string
  tp?: string
}

interface ObserveOptions {
  /** Push a `chat_complete` notification when a passive turn ends (leads, not teammates). */
  notifyOnTurnEnd?: boolean
}

interface ActiveRun {
  queue: PartQueue
  mapper: OperonStreamMapper
  /** The chat the turn renders on; without one there is nowhere to ask, so no handlers. */
  chat?: ChatRef
  approvals: Map<string, (response: ApprovalResponse) => void>
  questions: Map<string, (result: QuestionResult) => void>
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
/** The passive turn in flight on each session, by session id. */
const activeRuns = new Map<string, ActiveRun>()

/** The UI is streaming this session right now — the observer must not double-record. */
export function markDriven(sessionId: string): void {
  driven.add(sessionId)
}

export function unmarkDriven(sessionId: string): void {
  driven.delete(sessionId)
}

/**
 * Hand the session's approval / question handlers back once a UI-driven turn is done with them:
 * to the passive turn already running on it (the harness can wake the next run before the
 * driven turn's stream has wound down), else to nobody.
 */
export function restoreIdleHandlers(session: HarnessSession): void {
  const run = activeRuns.get(session.id)
  if (run) installHandlers(session, run)
  else clearHandlers(session)
}

/**
 * Answer a request a passive turn is waiting on (`POST /permission-response`, via the session
 * manager's external resolver). False when no passive turn of this chat is waiting on that id.
 */
export function resolvePassiveApproval(chatId: number, approvalId: string, decision: PermissionDecision): boolean {
  for (const run of activeRuns.values()) {
    if (run.chat?.chatId !== chatId) continue
    if (answerPending(run, approvalId, decision)) return true
  }
  return false
}

function installHandlers(session: HarnessSession, run: ActiveRun): void {
  if (!run.chat) {
    clearHandlers(session)
    return
  }
  const handlers = interactiveHandlers({
    push: (part) => run.queue.push(part),
    toolInput: (toolCallId) => run.mapper.toolInput(toolCallId),
    approvals: run.approvals,
    questions: run.questions,
  })
  session.setApprovalHandler(handlers.approval)
  session.setQuestionHandler(handlers.question)
}

function clearHandlers(session: HarnessSession): void {
  session.setApprovalHandler(undefined)
  session.setQuestionHandler(undefined)
}

export function isObserved(sessionId: string): boolean {
  return observed.has(sessionId)
}

/** Stop observing (session closed / harness torn down). */
export function unobserveSession(sessionId: string): void {
  observed.get(sessionId)?.unsubscribe()
  observed.delete(sessionId)
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
    if (activeRuns.get(session.id) === current) activeRuns.delete(session.id)
    // Nothing can answer once the turn is over; a driven turn owns the handlers while it runs.
    cancelPending(current)
    if (!driven.has(session.id)) clearHandlers(session)
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
      run = {
        queue: new PartQueue(),
        mapper: new OperonStreamMapper(),
        chat: resolveChat(session.id),
        approvals: new Map(),
        questions: new Map(),
      }
      activeRuns.set(session.id, run)
      installHandlers(session, run)
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
        if (chat) persistInjectedUserMessage(chat.chatId, userUiMessage(text, from))
      }
      // An open run still maps it: an assistant message carries the tool-call arguments an
      // approval request shows, and the reason a failed model call ended the step.
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
  return { chatId: row.id, workspaceId: row.workspaceId, model: row.model, title: row.title, tp: row.tp }
}

async function runPassiveTurn(session: HarnessSession, run: ActiveRun, options: ObserveOptions): Promise<void> {
  const chat = run.chat
  if (!chat) {
    // No chat row for this session: drain so the queue never backs up.
    for await (const _ of run.queue) {
      // discard
    }
    return
  }

  const message = await runDetachedTurn(
    {
      chatId: chat.chatId,
      modelId: chat.model,
      providerId: 'custom',
      sessionId: session.id,
      logTag: 'operon.peers',
      // A request waiting on the person marks the tab and reaches the inbox, as for any turn.
      onPart: (part) => observePendingInputPart(chat.chatId, part, { userFacing: chat.tp === 'chat' }),
    },
    run.queue,
  )
  if (!message) return

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
        body: replySnippet(message) ?? 'A teammate reported back',
      })
    }
  }
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
