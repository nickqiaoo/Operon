/**
 * Notices a background task sends into the conversation on its own, read out of the
 * user-role text that carries them. Two runtimes, two wire formats:
 *
 * Claude Code — one `<task-notification>` block per notice (several can share a message):
 *
 *   <task-notification>
 *   <task-id>b3yfn6bg7</task-id>
 *   <tool-use-id>toolu_…</tool-use-id>         (settles only)
 *   <status>completed</status>                 (settles only)
 *   <summary>Monitor event: "e2e failures"</summary>
 *   <event>1) [ci] › chat.spec.ts:15:1 › …</event>
 *   If this event is something the user would act on now, …   ← for the model
 *   </task-notification>
 *
 * operon agent — a Monitor's events and housekeeping come through the steer channel as
 * extension messages; its settle is the usual `<background-task-done>`:
 *
 *   <extension-message from="background" taskId="monitor-…" event="monitor_event">
 *   [system: automated event, NOT a message from the user. …]
 *   Monitor event: "e2e failures" (task monitor-…)
 *   <event>
 *   …
 *   </event>
 *   </extension-message>
 *
 *   <background-task-done taskId="monitor-…" toolCallId="…">
 *   [system: …]
 *   Monitor "e2e failures" stream ended
 *   </background-task-done>
 *
 * Every other `<background-task-done>` / `<extension-message>` stays with SteerNoticeMessage.
 */

import type { UIMessage } from 'ai'

/** Claude Code's and operon's watch tool share the name. */
export const isMonitorTool = (toolName: string) => toolName.replace(/^tool-/, '').toLowerCase() === 'monitor'

export type MonitorOutcome = 'ok' | 'error' | 'stopped' | 'expired'

export type BackgroundNotice =
  /** One batch of a Monitor's stdout. */
  | { type: 'monitor-event'; taskId?: string; description?: string; text: string }
  /** The monitor talking about itself: output suppressed, too much output. */
  | { type: 'monitor-notice'; taskId?: string; description?: string; text: string; warn: boolean }
  /** The watch is over. `status` is the human half of the settle line ("Stream ended"). */
  | { type: 'monitor-ended'; taskId?: string; description?: string; status: string; outcome: MonitorOutcome; text?: string }
  /** A Claude Code task that is not a monitor settled (a background command, a sub-agent). */
  | { type: 'task-done'; taskId?: string; summary?: string; outcome: MonitorOutcome }

const SYSTEM_STAMP = /^\[system:[\s\S]*?\]\s*/

function tagText(block: string, tag: string): string | undefined {
  const value = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1]
  return value === undefined ? undefined : value.trim()
}

function attr(openTag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(openTag)?.[1]
}

const capitalize = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text)

function outcomeOf(status: string | undefined, line: string): MonitorOutcome {
  if (/\b(expired|timed[ _]out)\b/i.test(line) || status === 'timed_out') return 'expired'
  switch (status) {
    case 'failed':
    case 'lost':
      return 'error'
    case 'stopped':
    case 'killed':
      return 'stopped'
    case 'completed':
      return 'ok'
  }
  if (/\b(script failed|failed)\b/i.test(line)) return 'error'
  if (/\bstopped\b/i.test(line)) return 'stopped'
  return 'ok'
}

/** `Monitor event: "desc"` (Claude) / `Monitor event: "desc" (task id)` (operon). */
const EVENT_HEAD = /^Monitor event: "([\s\S]*)"(?: \(task [^)]*\))?$/
/** `Monitor "desc" stream ended` / `… script failed (exit 1): …` / `… stopped`. */
const SETTLE_HEAD = /^Monitor "([\s\S]*)" ((?:stream ended|ended without producing output|script failed|stopped|expired|timed out|completed|failed|killed)[\s\S]*)$/
/** `[Monitor expired after 5m with 3 events delivered. Re-arm it …]` — no description in it. */
const EXPIRED_HEAD = /^\[Monitor (expired[^.\]]*)[.\]]/

/** The settle line split into the monitor's description and what happened to it. */
function readSettleLine(line: string): { description?: string; status: string } | undefined {
  const settle = SETTLE_HEAD.exec(line)
  if (settle) return { description: settle[1], status: capitalize(settle[2].replace(/\.$/, '')) }
  const expired = EXPIRED_HEAD.exec(line)
  if (expired) return { status: capitalize(expired[1]) }
  return undefined
}

/** A monitor's own notice is bracketed; the warning ones say it dropped or stopped output. */
const isWarnNotice = (text: string) => /suppressed|too much output|no events/i.test(text)

function parseTaskNotification(block: string): BackgroundNotice {
  const taskId = tagText(block, 'task-id')
  const status = tagText(block, 'status')
  const summary = tagText(block, 'summary') ?? ''
  const event = tagText(block, 'event')

  const head = EVENT_HEAD.exec(summary)
  if (head) {
    // An event with no output of its own is the monitor speaking: expiry, suppression.
    const text = event ?? ''
    if (/^\[[\s\S]*\]$/.test(text)) {
      return { type: 'monitor-notice', taskId, description: head[1], text: text.slice(1, -1), warn: isWarnNotice(text) }
    }
    return { type: 'monitor-event', taskId, description: head[1], text }
  }
  const settle = readSettleLine(summary)
  if (settle) {
    return {
      type: 'monitor-ended',
      taskId,
      description: settle.description,
      status: settle.status,
      outcome: outcomeOf(status, summary),
      ...(event ? { text: event } : {}),
    }
  }
  return { type: 'task-done', taskId, summary: summary || undefined, outcome: outcomeOf(status, summary) }
}

const TASK_NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g
const MONITOR_EXTENSION = /(<extension-message\b[^>]*\bfrom="background"[^>]*\bevent="monitor_(?:event|notice)"[^>]*>)([\s\S]*?)<\/extension-message>/g
const TASK_DONE = /(<background-task-done\b[^>]*>)([\s\S]*?)<\/background-task-done>/g

function parseMonitorExtension(openTag: string, inner: string): BackgroundNotice {
  const taskId = attr(openTag, 'taskId')
  const housekeeping = attr(openTag, 'event') === 'monitor_notice'
  const body = inner.trim().replace(SYSTEM_STAMP, '')
  const description = EVENT_HEAD.exec(body.split('\n')[0]?.trim() ?? '')?.[1]
  const text = tagText(body, 'event') ?? body
  if (housekeeping) {
    return { type: 'monitor-notice', taskId, description, text: text.replace(/^\[|\]$/g, ''), warn: isWarnNotice(text) }
  }
  return { type: 'monitor-event', taskId, description, text }
}

function parseMonitorSettle(openTag: string, inner: string): BackgroundNotice | undefined {
  const body = inner.trim().replace(SYSTEM_STAMP, '')
  const line = body.split('\n')[0]?.trim() ?? ''
  const settle = readSettleLine(line)
  if (!settle) return undefined
  return {
    type: 'monitor-ended',
    taskId: attr(openTag, 'taskId'),
    description: settle.description,
    status: settle.status,
    outcome: outcomeOf(undefined, line),
  }
}

/**
 * The background notices a message carries, in order — or undefined when it carries
 * none this module owns (a plain user message, a non-monitor operon settle).
 */
export function parseBackgroundNotices(text: string): BackgroundNotice[] | undefined {
  if (text.includes('<task-notification>')) {
    const notices = [...text.matchAll(TASK_NOTIFICATION)].map((m) => parseTaskNotification(m[1]))
    return notices.length > 0 ? notices : undefined
  }
  if (text.includes('<extension-message')) {
    const notices = [...text.matchAll(MONITOR_EXTENSION)].map((m) => parseMonitorExtension(m[1], m[2]))
    if (notices.length > 0) return notices
  }
  if (text.includes('<background-task-done')) {
    const notices: BackgroundNotice[] = []
    for (const m of text.matchAll(TASK_DONE)) {
      const notice = parseMonitorSettle(m[1], m[2])
      // Mixed with other tasks' settles: leave the whole message to SteerNoticeMessage.
      if (!notice) return undefined
      notices.push(notice)
    }
    if (notices.length > 0) return notices
  }
  return undefined
}

/** Which watch a notice belongs to: the task id, else its description. */
export function monitorKey(notice: BackgroundNotice): string | undefined {
  if (notice.type === 'task-done') return undefined
  return notice.taskId ?? notice.description
}

/** A message whose whole content is one monitor's events — the kind adjacent ones fold into. */
export function monitorEventsKey(text: string): string | undefined {
  const notices = parseBackgroundNotices(text)
  if (!notices || notices.some((n) => n.type !== 'monitor-event')) return undefined
  const keys = new Set(notices.map(monitorKey))
  if (keys.size !== 1) return undefined
  return [...keys][0]
}

export type NoticeRow =
  | { kind: 'events'; key?: string; description?: string; events: string[] }
  | { kind: 'single'; notice: Exclude<BackgroundNotice, { type: 'monitor-event' }> }

/** Consecutive events of one monitor become one row; everything else stays its own row. */
export function groupNotices(notices: readonly BackgroundNotice[]): NoticeRow[] {
  const rows: NoticeRow[] = []
  for (const notice of notices) {
    if (notice.type !== 'monitor-event') {
      rows.push({ kind: 'single', notice })
      continue
    }
    const key = monitorKey(notice)
    const last = rows.at(-1)
    if (last?.kind === 'events' && last.key === key) {
      last.events.push(notice.text)
      last.description ??= notice.description
    } else {
      rows.push({ kind: 'events', key, description: notice.description, events: [notice.text] })
    }
  }
  return rows
}


/** A message's text when text is all it holds; undefined for anything with other parts. */
function textOnly(message: UIMessage): string | undefined {
  const texts: string[] = []
  for (const part of message.parts) {
    if (part.type === 'text') texts.push(part.text)
    else if (part.type !== 'step-start') return undefined
  }
  return texts.length > 0 ? texts.join('\n') : undefined
}

/**
 * Adjacent user messages that hold nothing but the same monitor's events, folded into
 * the first of them — operon steers each event in as a message of its own, so a
 * chatty watch would otherwise stack one row per event between two replies. The
 * first message keeps its id; its text becomes all of theirs, which the renderer
 * then draws as one "N events" row. `pinned` ids are never folded away (a message
 * a turn's diff hangs off). Returns the input array itself when nothing folds.
 */
export function foldMonitorEventRuns(messages: UIMessage[], pinned?: ReadonlySet<string>): UIMessage[] {
  const result: UIMessage[] = []
  let run: { at: number; key: string; texts: string[] } | undefined
  let folded = false
  const flush = () => {
    if (!run || run.texts.length < 2) return
    const lead = result[run.at]
    result[run.at] = { ...lead, parts: [{ type: 'text', text: run.texts.join('\n') }] }
  }
  for (const message of messages) {
    const text = message.role === 'user' ? textOnly(message) : undefined
    const key = text !== undefined ? monitorEventsKey(text) : undefined
    if (key !== undefined && text !== undefined && run?.key === key && !pinned?.has(message.id)) {
      run.texts.push(text)
      folded = true
      continue
    }
    flush()
    result.push(message)
    run = key !== undefined && text !== undefined ? { at: result.length - 1, key, texts: [text] } : undefined
  }
  flush()
  return folded ? result : messages
}
