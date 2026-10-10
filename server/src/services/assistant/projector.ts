import type { RuntimeStreamPart } from '@operon/agent-runtime'
import type { Activity, ActivityStatus, ActivityStep, AssistantMessage, AssistantTrigger } from '../../../../shared/assistant.js'
import { bareToolName, isAssistantTool, stepLabel } from './labels.js'
import type { FinishArgs, HeartbeatArgs } from './tools.js'

const RESULT_LIMIT = 4_000

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

/** A one-line summary from a worker's final text: the first line that says something, not a lead-in. */
export function summaryLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/^[-*>\d.)\s]+/, '').replace(/\*\*|`/g, '').trim())
    .filter(Boolean)
  const line = lines.find((l) => !/[:：]$/.test(l)) ?? lines[0] ?? ''
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

/** What a tool returned, as text: MCP content, a bare string, or JSON. */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  const content = record(output).content
  if (Array.isArray(content)) {
    const text = content.map((c) => (record(c).type === 'text' ? String(record(c).text ?? '') : '')).join('')
    if (text) return text
  }
  if (output === undefined || output === null) return ''
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

/**
 * Text as the agent says it, cut into the pieces it said between tool calls: a piece ends at a
 * tool call, the end of a step or the end of the text block. Providers mark these differently;
 * any of them closes the piece.
 */
class TextSegments {
  private current = ''

  /** Feed a part; returns a piece that just ended, if one did. */
  feed(part: RuntimeStreamPart): string | undefined {
    switch (part.type) {
      case 'text-delta':
        this.current += (part as { text?: string }).text ?? ''
        return undefined
      case 'text-end':
      case 'tool-call':
      case 'tool-input-start':
      case 'tool-approval-request':
      case 'finish-step':
      case 'finish':
        return this.flush()
      default:
        return undefined
    }
  }

  flush(): string | undefined {
    const text = this.current.trim()
    this.current = ''
    return text || undefined
  }
}

// ---------------------------------------------------------------------------
// The thread: the main agent's session
// ---------------------------------------------------------------------------

/** Where the thread projector's output goes: persisted and broadcast by the runtime. */
export interface ThreadSink {
  /** Insert, or replace the message with the same id (a reply gaining a link or a remembered line). */
  message(message: AssistantMessage): void
  typing(typing: boolean): void
}

/** Why the main agent is speaking: what the host handed it. */
export type Cause =
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
 * Folds the main agent's turns into the thread the user sees: its replies only (no tool calls),
 * each tagged with why it was said and which activity it is about, plus whether it is typing.
 * The runtime tells it what each turn was fed (`begin`, `setCause`) — the host composes every
 * input, so it knows — and which worker a dispatch started (`dispatch`).
 */
export class AssistantProjector {
  private cause: Cause = { kind: 'user' }
  /** The worker the current turn dispatched — replies after the dispatch link to it. */
  private spawnedThisTurn: string | undefined
  /** Lines saved to memory.md this turn before any reply existed to carry them. */
  private remembered: string[] = []
  /** Replies emitted in the current turn — a remembered line or a dispatch attaches to the latest. */
  private turnMessages: AssistantMessage[] = []
  private segments = new TextSegments()
  private typing = false

  constructor(
    private readonly sink: ThreadSink,
    private readonly newId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** A turn starts on `cause` (what the host handed the agent). */
  begin(cause?: Cause): void {
    if (cause) this.cause = cause
    this.turnMessages = []
    this.segments = new TextSegments()
    this.setTyping(true)
  }

  /** Something else was injected into the running turn; what follows is about it. */
  setCause(cause: Cause): void {
    this.cause = cause
  }

  part(part: RuntimeStreamPart): void {
    const text = this.segments.feed(part)
    if (text) this.say(text)
  }

  /** The turn is over: say what is left, and say so if it failed. */
  end(result: { error?: string; aborted?: boolean } = {}): void {
    const rest = this.segments.flush()
    if (rest) this.say(rest)
    if (result.error && !result.aborted) this.say(`Something went wrong on my side: ${briefError(result.error)}`)
    this.setTyping(false)
    this.spawnedThisTurn = undefined
    this.turnMessages = []
    this.remembered = []
  }

  /**
   * A line saved to memory.md by the main agent. The model usually says "noted" around the save,
   * so the line goes onto the latest reply of this turn (re-emitted with the same id); with no
   * reply yet, onto the next one.
   */
  remember(line: string): void {
    const last = this.turnMessages.at(-1)
    if (!last) {
      this.remembered.push(line)
      return
    }
    last.remembered = [...(last.remembered ?? []), line]
    this.sink.message({ ...last })
  }

  /** The current turn started worker `activityId`: its acknowledgement links to it. */
  dispatch(activityId: string): void {
    this.spawnedThisTurn = activityId
    const last = this.turnMessages.at(-1)
    if (last && !last.activityId && !last.trigger) {
      last.activityId = activityId
      this.sink.message({ ...last })
    }
  }

  private setTyping(typing: boolean): void {
    if (this.typing === typing) return
    this.typing = typing
    this.sink.typing(typing)
  }

  private say(text: string): void {
    const activityId = 'activityId' in this.cause && this.cause.activityId ? this.cause.activityId : this.spawnedThisTurn
    const trigger = triggerOf(this.cause)
    const message: AssistantMessage = {
      id: this.newId(),
      role: 'assistant',
      text,
      createdAt: this.now(),
      ...(trigger ? { trigger } : {}),
      ...(activityId ? { activityId } : {}),
      ...(this.remembered.length ? { remembered: this.remembered.splice(0) } : {}),
    }
    this.turnMessages.push(message)
    this.sink.message(message)
  }
}

// ---------------------------------------------------------------------------
// One worker: its own session, one Activity
// ---------------------------------------------------------------------------

/** What a worker handed in through its finish tool. */
export type WorkerFinish = { tool: 'finish_task'; args: FinishArgs } | { tool: 'heartbeat_done'; args: HeartbeatArgs }

/** How a worker's run ended, as the runtime saw it. */
export type RunEnd = 'completed' | 'failed' | 'stopped' | 'timed_out'

/**
 * Folds one worker session's turns into its Activity: a step per tool call (named off the call
 * itself — see `stepLabel`), the result it handed in, and the final status.
 */
export class ActivityProjector {
  private finish: WorkerFinish | undefined
  private lastText: string | undefined
  /** Why the last turn failed — a run whose last turn failed did not complete. */
  private failure: string | undefined
  private segments = new TextSegments()

  constructor(
    readonly activity: Activity,
    private readonly sink: (activity: Activity) => void,
    private readonly newId: () => string,
    private readonly now: () => number = Date.now,
    /** The worker's directory: paths in step names are shown relative to it. */
    private readonly cwd?: string,
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
    this.emit()
  }

  /** Something the user told the running worker, shown as a step. */
  note(text: string): void {
    this.pushStep({ id: this.newId(), label: `You: ${text}`, status: 'done', tool: 'user_message', at: this.now() })
  }

  /** A milestone the worker reported, shown as a step. */
  progress(text: string): void {
    this.pushStep({ id: this.newId(), label: text, status: 'done', tool: 'report_progress', at: this.now() })
  }

  /** The worker handed in its result. */
  handIn(finish: WorkerFinish): void {
    this.finish = finish
  }

  /** Blocked on (or released from) an approval card. Only a live worker changes state. */
  setWaiting(waiting: boolean): void {
    if (!this.live) return
    const next = waiting ? 'waiting' : 'running'
    if (this.activity.status === next) return
    this.activity.status = next
    this.emit()
  }

  part(part: RuntimeStreamPart): void {
    const text = this.segments.feed(part)
    if (text) this.lastText = text
    const p = part as Record<string, unknown>
    switch (part.type) {
      case 'tool-call':
        return this.onToolCall(String(p.toolCallId ?? this.newId()), String(p.toolName ?? ''), p.input)
      case 'tool-result':
        if (p.preliminary === true) return
        return this.onToolResult(String(p.toolCallId ?? ''), p.output, p.isError === true)
      case 'tool-error':
        return this.onToolResult(String(p.toolCallId ?? ''), p.error instanceof Error ? p.error.message : p.error, true)
      default:
        return
    }
  }

  /** A turn of the worker ended. */
  turnEnd(result: { error?: string; aborted?: boolean }): void {
    const rest = this.segments.flush()
    if (rest) this.lastText = rest
    this.failure = result.error && !result.aborted ? briefError(result.error) : undefined
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

  private onToolCall(toolCallId: string, toolName: string, input: unknown): void {
    // The assistant's own tools (finish_task, report_progress…) are not steps of the work.
    if (isAssistantTool(toolName)) return
    const args = record(typeof input === 'string' ? safeJson(input) : input)
    this.pushStep({
      id: toolCallId,
      label: stepLabel(toolName, input, this.cwd),
      status: 'running',
      tool: bareToolName(toolName),
      ...(Object.keys(args).length ? { args } : {}),
      at: this.now(),
    })
  }

  private onToolResult(toolCallId: string, output: unknown, isError: boolean): void {
    const step = this.activity.steps.find((s) => s.id === toolCallId)
    if (!step) return
    step.status = isError ? 'failed' : 'done'
    const text = outputText(output)
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { command: text }
  }
}
