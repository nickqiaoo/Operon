import type { AgentEvent } from 'operon-agents'
import type { Activity, ActivityStatus, ActivityStep, AssistantMessage, AssistantTrigger } from '../../../../shared/assistant.js'
import { stripIntent } from './tools.js'

const RESULT_LIMIT = 4_000
/** Every session the assistant runs has a single frame: its root. */
const ROOT = 'main'
/** The main agent's dispatch tool (tools.ts). */
const DISPATCH_TOOL = 'start_task'
/** What a worker calls to hand in its result (tools.ts). */
export const FINISH_TOOLS = new Set(['finish_task', 'heartbeat_done'])

function textOf(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: unknown) =>
      part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : '',
    )
    .join('')
}

function roleOf(message: unknown): string | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const role = (message as { role?: unknown }).role
  return typeof role === 'string' ? role : undefined
}

/** Ids of the dispatch calls a message makes (the text before a dispatch rides in the same message). */
function dispatchCallIds(message: unknown): string[] {
  if (message === null || typeof message !== 'object') return []
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  return content.flatMap((part: unknown) => {
    const p = part !== null && typeof part === 'object' ? (part as Record<string, unknown>) : {}
    return p.type === 'toolCall' && p.name === DISPATCH_TOOL && typeof p.id === 'string' ? [p.id] : []
  })
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function truncate(text: string): string {
  return text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}\n… (truncated)` : text
}

/**
 * A provider error in one line: the status and the human message out of a JSON body
 * (`402 {"error":{"message":"This request requires more credits…"}}` → `402 · This request…`).
 */
export function briefError(text: string): string {
  const status = /^\s*(\d{3})\b/.exec(text)?.[1]
  const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]?.replace(/\\"/g, '"')
  const line = message ? `${status ? `${status} · ` : ''}${message}` : text.replace(/\s+/g, ' ').trim()
  return line.length > 240 ? `${line.slice(0, 237)}…` : line
}

/** The error a model call ended with: pi-ai puts it on the assistant message, not the turn. */
function modelErrorOf(message: unknown): string | undefined {
  const m = record(message)
  return m.stopReason === 'error' && typeof m.errorMessage === 'string' && m.errorMessage.trim() ? briefError(m.errorMessage) : undefined
}

/** A one-line summary from a worker's final text: the first line that says something, not a lead-in. */
export function summaryLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/^[-*>\d.)\s]+/, '').replace(/\*\*|`/g, '').trim())
    .filter(Boolean)
  const line = lines.find((l) => !/[:：]$/.test(l)) ?? lines[0] ?? ''
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

// ---------------------------------------------------------------------------
// The thread: the main agent's session
// ---------------------------------------------------------------------------

/** Where the thread projector's output goes: persisted and broadcast by the runtime. */
export interface ThreadSink {
  /** Insert, or replace the message with the same id (a reply gaining a remembered line). */
  message(message: AssistantMessage): void
  typing(typing: boolean): void
}

/** Why the main agent is speaking in the current turn. */
type Cause =
  | { kind: 'user' }
  | { kind: 'worker'; activityId?: string }
  | { kind: 'progress'; activityId?: string }
  | { kind: 'heartbeat'; activityId?: string }
  | { kind: 'schedule'; name: string; activityId?: string }
  | { kind: 'system' }

function triggerOf(cause: Cause): AssistantTrigger | undefined {
  switch (cause.kind) {
    case 'worker':
      return cause.activityId ? { kind: 'worker', activityId: cause.activityId } : undefined
    case 'heartbeat':
      return { kind: 'heartbeat' }
    case 'schedule':
      return { kind: 'schedule', name: cause.name }
    default:
      return undefined
  }
}

/**
 * Folds the main agent's AgentEvent stream into the thread the user sees: its replies only (no
 * tool calls), each tagged with why it was said and which activity it is about, plus whether
 * it is typing. Workers run in sessions of their own (workers.ts); this one only hears about
 * them through the notices the runtime steers in and the dispatches the runtime reports.
 */
export class AssistantProjector {
  private cause: Cause = { kind: 'user' }
  /** The worker the current main turn dispatched — its ack message links to it. */
  private spawnedThisTurn: string | undefined
  /** Lines saved to memory.md this turn before any reply existed to carry them. */
  private remembered: string[] = []
  /** Main replies emitted in the current turn — a remembered line attaches to the latest. */
  private turnMessages: AssistantMessage[] = []
  /**
   * Replies that also dispatch a worker ("On it" + start_task in one message). Held until the
   * dispatch has run, so the reply can link to its activity; released at turn end regardless.
   */
  private readonly held = new Map<string, AssistantMessage>()
  /** Dispatches that ran before the message carrying them was appended. */
  private readonly dispatched = new Map<string, string>()
  /** Why the current turn's model call failed, when it said so. */
  private modelError: string | undefined
  private typing = false

  constructor(
    private readonly sink: ThreadSink,
    private readonly newId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A line saved to memory.md by the main agent. The model usually says "noted" in the same
   * message that makes the save, so the line goes onto the latest reply of this turn (re-emitted
   * with the same id); with no reply yet, onto the next one.
   */
  remember(line: string): void {
    const last = this.turnMessages.at(-1)
    if (!last) {
      this.remembered.push(line)
      return
    }
    last.remembered = [...(last.remembered ?? []), line]
    if (![...this.held.values()].includes(last)) this.sink.message({ ...last })
  }

  /** The main agent's dispatch call `toolCallId` started worker `activityId`. */
  dispatch(toolCallId: string, activityId: string): void {
    this.spawnedThisTurn = activityId
    const message = this.held.get(toolCallId)
    if (!message) {
      this.dispatched.set(toolCallId, activityId)
      return
    }
    for (const [id, m] of this.held) if (m === message) this.held.delete(id)
    message.activityId ??= activityId
    this.sink.message(message)
  }

  handle(event: AgentEvent): void {
    if (event.address !== ROOT) return
    switch (event.type) {
      case 'turn.started':
        this.turnMessages = []
        this.setTyping(true)
        return
      case 'turn.ended':
        for (const message of new Set(this.held.values())) this.sink.message(message)
        this.held.clear()
        this.dispatched.clear()
        if (event.reason === 'failed') {
          this.say(`Something went wrong on my side: ${event.error ? briefError(event.error) : (this.modelError ?? 'unknown error')}`)
        }
        this.modelError = undefined
        this.setTyping(false)
        this.spawnedThisTurn = undefined
        this.turnMessages = []
        this.remembered = []
        return
      case 'message.appended':
        return this.onMessage(event)
      default:
        return
    }
  }

  private setTyping(typing: boolean): void {
    if (this.typing === typing) return
    this.typing = typing
    this.sink.typing(typing)
  }

  private say(text: string, extra: Partial<AssistantMessage> = {}, holdFor: string[] = []): void {
    const message: AssistantMessage = { id: this.newId(), role: 'assistant', text, createdAt: this.now(), ...extra }
    this.turnMessages.push(message)
    // A dispatch that already ran links straight away; otherwise wait for it.
    const ran = holdFor.map((id) => this.dispatched.get(id)).find(Boolean)
    if (ran) message.activityId ??= ran
    if (holdFor.length && !message.activityId) {
      for (const id of holdFor) this.held.set(id, message)
      return
    }
    this.sink.message(message)
  }

  private onMessage(event: Extract<AgentEvent, { type: 'message.appended' }>): void {
    const role = roleOf(event.message)
    if (role === 'user') {
      this.cause = this.causeOf(record(event.origin))
      return
    }
    if (role !== 'assistant') return
    this.modelError = modelErrorOf(event.message) ?? this.modelError
    const text = textOf(event.message).trim()
    if (!text) return
    const activityId = 'activityId' in this.cause && this.cause.activityId ? this.cause.activityId : this.spawnedThisTurn
    const trigger = triggerOf(this.cause)
    this.say(
      text,
      {
        ...(trigger ? { trigger } : {}),
        ...(activityId ? { activityId } : {}),
        ...(this.remembered.length ? { remembered: this.remembered.splice(0) } : {}),
      },
      dispatchCallIds(event.message),
    )
  }

  private causeOf(origin: Record<string, unknown>): Cause {
    switch (origin.kind) {
      case 'external': {
        const meta = record(origin.metadata)
        const activityId = str(meta.activityId)
        const linked = activityId ? { activityId } : {}
        switch (origin.source) {
          case 'worker-done':
            return { kind: 'worker', ...linked }
          case 'worker-progress':
            return { kind: 'progress', ...linked }
          case 'heartbeat':
            return { kind: 'heartbeat', ...linked }
          case 'schedule':
            return { kind: 'schedule', name: str(meta.name) ?? 'Scheduled task', ...linked }
          default:
            return { kind: 'system' }
        }
      }
      case 'injection':
        // Context the framework adds (skill catalog, reminders) — not a new reason to speak.
        return this.cause
      default:
        return { kind: 'user' }
    }
  }
}

// ---------------------------------------------------------------------------
// One worker: its own session, one Activity
// ---------------------------------------------------------------------------

/** What a worker handed in through its finish tool, by tool name. */
export interface WorkerFinish {
  tool: string
  args: Record<string, unknown>
}

/** How a worker's run ended, as the runtime saw it. */
export type RunEnd = 'completed' | 'failed' | 'stopped' | 'timed_out'

/**
 * Folds one worker session's events into its Activity: a step per tool call (named by the
 * call's `intent`), the result it handed in, and the final status. The worker is the session's
 * root, so everything it does arrives on address `main`.
 */
export class ActivityProjector {
  private finish: WorkerFinish | undefined
  private lastText: string | undefined
  /** A turn that failed, and why — a run whose last turn failed did not complete. */
  private failure: string | undefined
  private modelError: string | undefined

  constructor(
    readonly activity: Activity,
    private readonly sink: (activity: Activity) => void,
    private readonly newId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  get live(): boolean {
    return this.activity.status === 'running' || this.activity.status === 'waiting'
  }

  /** The result the worker handed in, if it did. */
  get finished(): WorkerFinish | undefined {
    return this.finish
  }

  /** The worker's last words — the full result, by the worker's rules. */
  get finalText(): string | undefined {
    return this.lastText
  }

  get error(): string | undefined {
    return this.failure
  }

  /** Publish the activity as it stands (first sight, or after a change made from outside). */
  publish(): void {
    this.emit()
  }

  /** Working again on the same activity: a finished task continued, more steps to come. */
  reopen(): void {
    this.activity.status = 'running'
    this.activity.summary = 'Working…'
    delete this.activity.finishedAt
    this.finish = undefined
    this.lastText = undefined
    this.failure = undefined
    this.modelError = undefined
    this.emit()
  }

  /** Something the user told the running worker, shown as a step. */
  note(text: string): void {
    this.pushStep({ id: this.newId(), label: `You: ${text}`, status: 'done', tool: 'user_message', at: this.now() })
  }

  /** Blocked on (or released from) an approval card. Only a live worker changes state. */
  setWaiting(waiting: boolean): void {
    if (!this.live) return
    const next = waiting ? 'waiting' : 'running'
    if (this.activity.status === next) return
    this.activity.status = next
    this.emit()
  }

  handle(event: AgentEvent): void {
    if (event.address !== ROOT) return
    switch (event.type) {
      case 'turn.ended':
        this.failure = event.reason === 'failed' ? (event.error ? briefError(event.error) : (this.modelError ?? 'unknown error')) : undefined
        this.modelError = undefined
        return
      case 'message.appended': {
        if (roleOf(event.message) !== 'assistant') return
        this.modelError = modelErrorOf(event.message) ?? this.modelError
        const text = textOf(event.message).trim()
        if (text) this.lastText = text
        return
      }
      case 'tool.call.started':
        return this.onToolCall(event.toolCallId, event.toolName, event.args)
      case 'tool.result':
        return this.onToolResult(event.toolCallId, event.result, event.isError)
      default:
        return
    }
  }

  /** Close the activity from how the run ended and whatever the worker handed in. */
  settle(end: RunEnd, fallbackTitle?: string): void {
    const finish = this.finish?.tool === 'finish_task' ? this.finish.args : undefined
    const ok = end === 'completed' && !this.failure
    let status: ActivityStatus
    if (ok) {
      const s = finish?.status
      status = s === 'partial' || s === 'failed' ? s : 'done'
    } else if (end === 'stopped') {
      status = 'stopped'
    } else {
      status = 'failed'
    }
    const a = this.activity
    a.status = status
    a.finishedAt = this.now()
    const title = str(finish?.title) ?? fallbackTitle
    if (title) a.title = title
    const summary = str(finish?.summary)
    a.summary =
      status === 'stopped'
        ? 'Stopped'
        : end === 'timed_out'
          ? 'Took too long and was stopped'
          : (summary ?? (this.lastText ? summaryLine(this.lastText) : undefined) ?? (status === 'failed' ? (this.failure ?? 'Failed') : 'Done'))
    const report = [summary, this.lastText].filter((t): t is string => Boolean(t && t.trim()))
    if (report.length) a.report = [...new Set(report)].join('\n\n')
    for (const step of a.steps) if (step.status === 'running') step.status = ok ? 'done' : 'failed'
    this.emit()
  }

  private onToolCall(toolCallId: string, toolName: string, args: unknown): void {
    if (FINISH_TOOLS.has(toolName)) {
      this.finish = { tool: toolName, args: record(args) }
      return
    }
    if (toolName === 'report_progress') {
      const text = str(record(args).text)
      if (text) this.pushStep({ id: toolCallId, label: text, status: 'done', tool: toolName, at: this.now() })
      return
    }
    const { intent, rest } = stripIntent(args)
    this.pushStep({
      id: toolCallId,
      label: intent ?? toolName,
      status: 'running',
      tool: toolName,
      ...(rest !== null && typeof rest === 'object' && !Array.isArray(rest) ? { args: rest as Record<string, unknown> } : {}),
      at: this.now(),
    })
  }

  private onToolResult(toolCallId: string, result: unknown, isError: boolean | undefined): void {
    const step = this.activity.steps.find((s) => s.id === toolCallId)
    if (!step) return
    step.status = isError ? 'failed' : 'done'
    const text = textOf(result)
    if (text) step.result = truncate(text)
    this.emit()
  }

  private pushStep(step: ActivityStep): void {
    this.activity.steps.push(step)
    this.emit()
  }

  private emit(): void {
    // Hand out a copy: the sink persists/broadcasts it, we keep mutating ours.
    this.sink({ ...this.activity, steps: this.activity.steps.map((s) => ({ ...s })) })
  }
}
