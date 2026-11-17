import type { OpenCodeEvent } from '@opencode/client'
import type { RuntimeBackgroundTask } from '../../types.js'

/** The tool OpenCode launches a sub-agent with (`subagent` since 2.3; `task` before). */
export const OPENCODE_SUBAGENT_TOOLS = new Set(['subagent', 'task', 'Subtask'])

/** How long a finished sub-agent may wait for its report to reach the parent before we stop listening for it. */
const REPORT_GRACE_MS = 60_000

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The child session a sub-agent call's metadata names, as OpenCode spells it. */
export function childSessionOf(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined
  const id = metadata.sessionID ?? metadata.sessionId
  return typeof id === 'string' && id ? id : undefined
}

/** The report inside `<subagent …>…</subagent>`, without the wrapper. */
function reportText(text: string): string {
  return text.replace(/^\s*<subagent\b[^>]*>\s*/, '').replace(/\s*<\/subagent>\s*$/, '').trim()
}

interface TrackedTask extends RuntimeBackgroundTask {
  /** The parent has not yet taken in this sub-agent's report. */
  awaitingReport: boolean
  reportDeadline?: number
}

/**
 * The background sub-agents a session launched, read off its event stream.
 *
 * OpenCode 2.3 runs a sub-agent in the background: the parent's `subagent` call
 * succeeds at once with `{ sessionID, status: 'running' }`, the child session
 * works on, and when it ends the parent receives its report as a synthetic inbox
 * message (`metadata.source === 'subagent'`) and starts a reply of its own. This
 * keeps the list a sub-agent card reads its status from (`toolUseId` is the
 * parent's call) and says whether anything is still on its way.
 */
export class OpencodeBackgroundSubagents {
  private readonly tasks = new Map<string, TrackedTask>()
  /** Tool names by call id (the name arrives on `input.started`, the input on `called`). */
  private readonly toolNames = new Map<string, string>()
  private readonly toolInputs = new Map<string, JsonRecord>()
  /** Report inbox ids by child session, to know when the parent took the report in. */
  private readonly reportInbox = new Map<string, string>()

  constructor(
    private readonly parentSessionId: () => string | undefined,
    private readonly onChange: (tasks: RuntimeBackgroundTask[]) => void,
  ) {}

  /** Child sessions launched in the background, by id. */
  has(childSessionId: string): boolean {
    return this.tasks.has(childSessionId)
  }

  /** The call that launched a child session. */
  callOf(childSessionId: string): string | undefined {
    return this.tasks.get(childSessionId)?.toolUseId
  }

  /** Something is still running, or a finished sub-agent's report has yet to reach the parent. */
  active(now = Date.now()): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') return true
      if (task.awaitingReport && (task.reportDeadline ?? Infinity) > now) return true
    }
    return false
  }

  /** When the earliest report still awaited stops holding the stream open. */
  nextDeadline(): number | undefined {
    let next: number | undefined
    for (const task of this.tasks.values()) {
      if (task.status === 'running' || !task.awaitingReport || task.reportDeadline === undefined) continue
      next = next === undefined ? task.reportDeadline : Math.min(next, task.reportDeadline)
    }
    return next
  }

  list(): RuntimeBackgroundTask[] {
    return [...this.tasks.values()].map(({ awaitingReport: _awaiting, reportDeadline: _deadline, ...task }) => task)
  }

  clearFinished(): void {
    let changed = false
    for (const [id, task] of this.tasks) {
      if (task.status === 'running' || task.awaitingReport) continue
      this.tasks.delete(id)
      changed = true
    }
    if (changed) this.emit()
  }

  handle(event: OpenCodeEvent): void {
    const parent = this.parentSessionId()
    if (!parent) return
    switch (event.type) {
      case 'session.tool.input.started':
        this.toolNames.set(event.data.id, event.data.name)
        if (event.data.sessionID !== parent) this.countStep(event.data.sessionID, event.data.name)
        return
      case 'session.tool.called':
        if (event.data.sessionID === parent) this.toolInputs.set(event.data.id, event.data.input)
        return
      case 'session.tool.success':
        if (event.data.sessionID === parent) this.launched(event.data.id, event.data.metadata, event.created)
        this.forgetCall(event.data.id)
        return
      case 'session.tool.failed':
        this.forgetCall(event.data.id)
        return
      case 'session.execution.succeeded':
        this.settle(event.data.sessionID, 'completed', event.created)
        return
      case 'session.execution.failed':
        this.settle(event.data.sessionID, 'failed', event.created, event.data.error.message)
        return
      case 'session.execution.interrupted':
        this.settle(event.data.sessionID, 'stopped', event.created)
        return
      case 'session.inbox.enqueued': {
        if (event.data.sessionID !== parent || event.data.item.type !== 'synthetic') return
        const payload = event.data.item.payload
        const metadata = payload.metadata
        if (!isRecord(metadata) || metadata.source !== 'subagent' || typeof metadata.childID !== 'string') return
        const task = this.tasks.get(metadata.childID)
        if (!task) return
        this.reportInbox.set(metadata.childID, event.data.inboxID)
        const report = reportText(payload.text)
        if (report) task.summary = report
        task.reportDeadline ??= Date.now() + REPORT_GRACE_MS
        const state = typeof metadata.state === 'string' ? metadata.state : undefined
        if (task.status === 'running') {
          task.status = state === 'error' || state === 'failed' ? 'failed' : state === 'cancelled' || state === 'interrupted' ? 'stopped' : 'completed'
          task.endedAt = event.created
        }
        this.emit()
        return
      }
      case 'session.inbox.delivered':
      case 'session.inbox.cancelled': {
        if (event.data.sessionID !== parent) return
        for (const [child, inboxID] of this.reportInbox) {
          if (inboxID !== event.data.inboxID) continue
          this.reportInbox.delete(child)
          const task = this.tasks.get(child)
          if (task) task.awaitingReport = false
        }
        return
      }
      default:
        return
    }
  }

  private launched(callId: string, metadata: unknown, created: number): void {
    const name = this.toolNames.get(callId)
    const child = childSessionOf(metadata)
    if (!name || !OPENCODE_SUBAGENT_TOOLS.has(name) || !child || !isRecord(metadata) || metadata.status !== 'running') return
    if (this.tasks.has(child)) return
    const input = this.toolInputs.get(callId) ?? {}
    const description = typeof input.description === 'string' ? input.description
      : typeof input.prompt === 'string' ? input.prompt.slice(0, 120) : 'Sub-agent'
    this.tasks.set(child, {
      taskId: child,
      toolUseId: callId,
      taskType: typeof input.agent === 'string' ? `subagent:${input.agent}` : 'subagent',
      backgrounded: true,
      description,
      status: 'running',
      toolUses: 0,
      startedAt: created,
      awaitingReport: true,
    })
    this.emit()
  }

  private countStep(sessionId: string, toolName: string): void {
    const task = this.tasks.get(sessionId)
    if (!task || task.status !== 'running') return
    task.toolUses = (task.toolUses ?? 0) + 1
    task.lastToolName = toolName
    this.emit()
  }

  private settle(sessionId: string, status: 'completed' | 'failed' | 'stopped', created: number, error?: string): void {
    const task = this.tasks.get(sessionId)
    if (!task || task.status !== 'running') return
    task.status = status
    task.endedAt = created
    if (error && !task.summary) task.summary = error
    task.reportDeadline = Date.now() + REPORT_GRACE_MS
    this.emit()
  }

  private forgetCall(callId: string): void {
    this.toolNames.delete(callId)
    this.toolInputs.delete(callId)
  }

  private emit(): void {
    this.onChange(this.list())
  }
}
