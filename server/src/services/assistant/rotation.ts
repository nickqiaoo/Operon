import type { Activity, AssistantMessage, ProfileFile, ProfileFileName } from '../../../../shared/assistant.js'
import { attachmentLabel } from './attachments.js'

/**
 * The main agent's session is swapped for a fresh one once a day (docs/assistant/design.md §3):
 * the thread on screen never breaks, the model's context does, and memory.md plus a short seed
 * carry it across. This file is the bookkeeping for that — no sessions, no I/O.
 */

/** Sessions turn over at the first event after this local hour. */
export const ROTATION_HOUR = 4
/** How much of the thread a new session starts with. */
const SEED_MESSAGES = 20
const SEED_CHARS = 12_000
const SEED_MESSAGE_CHARS = 600
const SEED_TASKS = 6
/** How much of a finished session the wrap-up reads (its tail, if longer). */
const WRAP_UP_CHARS = 40_000
/** The main agent hears the time again once this much has passed. */
const TIME_REMINDER_MS = 15 * 60_000

/** The latest rotation moment at or before `now`: today's 04:00, or yesterday's before that. */
export function lastBoundary(now: number, hour = ROTATION_HOUR): number {
  const d = new Date(now)
  d.setHours(hour, 0, 0, 0)
  if (d.getTime() > now) d.setDate(d.getDate() - 1)
  return d.getTime()
}

/** A session started before the latest boundary has had its day. */
export function rotationDue(startedAt: number | undefined, now: number): boolean {
  return startedAt !== undefined && startedAt < lastBoundary(now)
}

function clock(at: number): string {
  return new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Things said in the thread, approval cards and blanks left out. */
function spoken(messages: readonly AssistantMessage[]): AssistantMessage[] {
  return messages.filter((m) => !m.approval && (m.text.trim() || m.attachments?.length))
}

function line(m: AssistantMessage, max: number): string {
  const said = [clip(m.text, max), attachmentLabel(m.attachments)].filter(Boolean).join(' ')
  return `[${clock(m.createdAt)}] ${m.role === 'user' ? 'User' : 'You'}: ${said}`
}

/**
 * What a fresh session is told about before it: the end of the thread (so "what did you just
 * say?" still works) and the latest tasks with their ids (so they can be continued).
 * @param messages oldest first
 * @param activities newest first
 */
export function buildSessionSeed(messages: readonly AssistantMessage[], activities: readonly Activity[]): string {
  const lines: string[] = []
  let size = 0
  for (const m of spoken(messages).slice(-SEED_MESSAGES).reverse()) {
    const l = line(m, SEED_MESSAGE_CHARS)
    if (size + l.length > SEED_CHARS) break
    lines.unshift(l)
    size += l.length
  }
  const tasks = activities.slice(0, SEED_TASKS).map((a) => `- ${a.id} · ${a.status} · ${a.title} — ${clip(a.summary, 200)}`)
  if (!lines.length && !tasks.length) return ''
  return [
    ...(lines.length ? ['The conversation so far ended with:', ...lines] : []),
    ...(tasks.length ? ['', 'Recent tasks (continue_task works on these ids):', ...tasks] : []),
  ].join('\n')
}

/**
 * A finished session's part of the thread, for the wrap-up that looks for anything memory.md
 * should keep. Finished tasks ride along as what they produced, in time order.
 */
export function buildWrapUpTranscript(messages: readonly AssistantMessage[], activities: readonly Activity[]): string {
  type Entry = { at: number; text: string }
  const entries: Entry[] = [
    ...spoken(messages).map((m) => ({ at: m.createdAt, text: line(m, 2_000) })),
    ...activities
      .filter((a) => a.finishedAt !== undefined && a.status !== 'stopped')
      .map((a) => ({ at: a.finishedAt!, text: `[${clock(a.finishedAt!)}] Task "${a.title}" (${a.status}): ${clip(a.report ?? a.summary, 1_500)}` })),
  ].sort((a, b) => a.at - b.at)
  let text = entries.map((e) => e.text).join('\n')
  if (text.length > WRAP_UP_CHARS) text = `…\n${text.slice(text.length - WRAP_UP_CHARS)}`
  return text
}

/**
 * The definition files whose edits mid-session the main agent is told about. Not heartbeat.md: it
 * isn't in the main agent's instructions (it reads the file when it needs it), and the heartbeat
 * rewrites its own section of it every time it reports.
 */
const WATCHED: readonly ProfileFileName[] = ['memory']

/**
 * What the main agent is told at the start of a turn, between rotations: its system prompt is
 * fixed for the session (prompt cache), so a file someone else changed, and the time of day,
 * arrive as a short note instead. Its own edits are not echoed back — it made them.
 */
export class ContextReminder {
  private readonly seen = new Map<ProfileFileName, number>()
  private timeToldAt = 0

  constructor(
    private readonly files: () => readonly ProfileFile[],
    private readonly now: () => number = Date.now,
  ) {
    this.markAll()
  }

  /** The system prompt was (re)built from the files as they are now. */
  markAll(): void {
    for (const f of this.files()) this.seen.set(f.name, f.updatedAt)
  }

  /** The main agent wrote this file itself. */
  mark(name: ProfileFileName): void {
    const f = this.files().find((x) => x.name === name)
    if (f) this.seen.set(name, f.updatedAt)
  }

  /** The note for this turn, or null when nothing changed. */
  next(): string | null {
    const parts: string[] = []
    const now = this.now()
    if (now - this.timeToldAt >= TIME_REMINDER_MS) {
      this.timeToldAt = now
      parts.push(`It is now ${new Date(now).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}.`)
    }
    for (const f of this.files()) {
      if (!WATCHED.includes(f.name) || (this.seen.get(f.name) ?? 0) >= f.updatedAt) continue
      this.seen.set(f.name, f.updatedAt)
      parts.push(`${f.name}.md was just changed${f.updatedBy === 'user' ? ' by the user' : ''}. It now reads:\n<${f.name}.md>\n${f.content.trim() || '(empty)'}\n</${f.name}.md>\nThis replaces the copy in your instructions.`)
    }
    return parts.length ? parts.join('\n\n') : null
  }
}
