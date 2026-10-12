import { defineMessages, type IntlShape, type MessageDescriptor } from "react-intl"
import {
  INTERRUPTED_SUMMARY,
  TURN_ERROR_PREFIX,
  UNATTENDED_SKIP_PREFIX,
  WORKING_SUMMARY,
  type AssistantBlockerReason,
} from "@shared/assistant"
import type { ActivityStatus, ApprovalDecision, AuditRecord } from "./types"

/**
 * The assistant's enum labels and date words as react-intl descriptors. They are used both as
 * plain strings (titles, placeholders) and in JSX, so they are translated at the call site via
 * `intl.formatMessage(...)`; `defineMessages` keeps them extractable (English is the source).
 */
export const ACTIVITY_STATUS_MESSAGES = defineMessages({
  running: { id: "assistant.status.running", defaultMessage: "Running" },
  waiting: { id: "assistant.status.waiting", defaultMessage: "Waiting for you" },
  done: { id: "assistant.status.done", defaultMessage: "Done" },
  partial: { id: "assistant.status.partial", defaultMessage: "Done, with gaps" },
  failed: { id: "assistant.status.failed", defaultMessage: "Failed" },
  stopped: { id: "assistant.status.stopped", defaultMessage: "Stopped" },
}) satisfies Record<ActivityStatus, MessageDescriptor>

/** Who did an activity: the main agent in the conversation, or a worker on a task. */
export const AGENT_MESSAGES = defineMessages({
  main: { id: "assistant.agent.main", defaultMessage: "Main" },
  worker: { id: "assistant.agent.worker", defaultMessage: "Worker" },
})

export const DECISION_MESSAGES = defineMessages({
  allowed_once: { id: "assistant.decision.allowedOnce", defaultMessage: "Allowed once" },
  always_allowed: { id: "assistant.decision.alwaysAllowed", defaultMessage: "Always allowed" },
  auto_allowed: { id: "assistant.decision.autoAllowed", defaultMessage: "Auto-allowed" },
  denied: { id: "assistant.decision.denied", defaultMessage: "Denied" },
  expired: { id: "assistant.decision.expired", defaultMessage: "Expired" },
}) satisfies Record<ApprovalDecision | AuditRecord["decision"], MessageDescriptor>

const DAY_MESSAGES = defineMessages({
  today: { id: "assistant.day.today", defaultMessage: "Today" },
  yesterday: { id: "assistant.day.yesterday", defaultMessage: "Yesterday" },
  tomorrow: { id: "assistant.day.tomorrow", defaultMessage: "Tomorrow" },
})

const TIME_AGO_MESSAGES = defineMessages({
  justNow: { id: "assistant.time.justNow", defaultMessage: "just now" },
  minutes: { id: "assistant.time.minutesAgo", defaultMessage: "{count}m ago" },
  hours: { id: "assistant.time.hoursAgo", defaultMessage: "{count}h ago" },
  days: { id: "assistant.time.daysAgo", defaultMessage: "{count}d ago" },
  weeks: { id: "assistant.time.weeksAgo", defaultMessage: "{count}w ago" },
})

const BUSY_MESSAGES = defineMessages({
  idle: { id: "assistant.busy.idle", defaultMessage: "Idle" },
  working: { id: "assistant.busy.working", defaultMessage: "Working" },
})

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "Today" / "Yesterday" / "Tomorrow", else a short date in the app's language ("10月12日周日"). */
export function dayLabel(intl: IntlShape, ms: number): string {
  const diffDays = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / 86_400_000)
  if (diffDays === 0) return intl.formatMessage(DAY_MESSAGES.today)
  if (diffDays === 1) return intl.formatMessage(DAY_MESSAGES.yesterday)
  if (diffDays === -1) return intl.formatMessage(DAY_MESSAGES.tomorrow)
  return intl.formatDate(ms, { weekday: "short", month: "short", day: "numeric" })
}

/** "just now" / "5m ago" / "2h ago" / "3d ago" / "1w ago". */
export function timeAgo(intl: IntlShape, ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return intl.formatMessage(TIME_AGO_MESSAGES.justNow)
  const m = Math.floor(s / 60)
  if (m < 60) return intl.formatMessage(TIME_AGO_MESSAGES.minutes, { count: m })
  const h = Math.floor(m / 60)
  if (h < 24) return intl.formatMessage(TIME_AGO_MESSAGES.hours, { count: h })
  const d = Math.floor(h / 24)
  if (d < 7) return intl.formatMessage(TIME_AGO_MESSAGES.days, { count: d })
  return intl.formatMessage(TIME_AGO_MESSAGES.weeks, { count: Math.floor(d / 7) })
}

/** "Idle" / "Working" — the assistant's status line. No count: how many is the Activity tab's job. */
export function busyLabel(intl: IntlShape, busy: boolean): string {
  return intl.formatMessage(busy ? BUSY_MESSAGES.working : BUSY_MESSAGES.idle)
}

const CADENCE_MESSAGES = defineMessages({
  everyMinutes: { id: "assistant.cadence.everyMinutes", defaultMessage: "Every {count} minutes" },
  everyHour: { id: "assistant.cadence.everyHour", defaultMessage: "Every hour" },
  everyHours: { id: "assistant.cadence.everyHours", defaultMessage: "Every {count} hours" },
  window: { id: "assistant.cadence.window", defaultMessage: "{every}, {start}–{end}" },
  onDays: { id: "assistant.cadence.onDays", defaultMessage: "{what} on {days}" },
  daily: { id: "assistant.cadence.daily", defaultMessage: "Daily at {time}" },
  weekdays: { id: "assistant.cadence.weekdays", defaultMessage: "Weekdays at {time}" },
  weekends: { id: "assistant.cadence.weekends", defaultMessage: "Weekends at {time}" },
  daysAt: { id: "assistant.cadence.daysAt", defaultMessage: "{days} at {time}" },
  weekdaysWord: { id: "assistant.cadence.weekdaysWord", defaultMessage: "weekdays" },
  weekendsWord: { id: "assistant.cadence.weekendsWord", defaultMessage: "weekends" },
})

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((d, i) => d === b[i])
}

/** The weekday's short name in the app's language (0 = Sunday). 2024-01-07 was a Sunday. */
function weekdayName(intl: IntlShape, day: number): string {
  return intl.formatDate(new Date(2024, 0, 7 + day), { weekday: "short" })
}

/**
 * "Every 30 minutes", "Weekdays at 08:40", "Every 2 hours, 09:00–18:00 on weekends" — the same
 * rules as the server's `cadenceOf` (schedule.ts), but in the app's language.
 */
export function cadenceLabel(
  intl: IntlShape,
  schedule: { time: string; days: number[]; everyMinutes?: number; until?: string },
): string {
  const days = [...schedule.days].sort()
  const everyDay = sameDays(days, [0, 1, 2, 3, 4, 5, 6])
  const weekdays = sameDays(days, [1, 2, 3, 4, 5])
  const weekends = sameDays(days, [0, 6])
  if (schedule.everyMinutes) {
    const n = schedule.everyMinutes
    let what =
      n % 60 !== 0
        ? intl.formatMessage(CADENCE_MESSAGES.everyMinutes, { count: n })
        : n === 60
          ? intl.formatMessage(CADENCE_MESSAGES.everyHour)
          : intl.formatMessage(CADENCE_MESSAGES.everyHours, { count: n / 60 })
    const allDay = schedule.time === "00:00" && (schedule.until ?? "23:59") === "23:59"
    if (!allDay) what = intl.formatMessage(CADENCE_MESSAGES.window, { every: what, start: schedule.time, end: schedule.until ?? "23:59" })
    if (everyDay) return what
    const dayWords = weekdays
      ? intl.formatMessage(CADENCE_MESSAGES.weekdaysWord)
      : weekends
        ? intl.formatMessage(CADENCE_MESSAGES.weekendsWord)
        : intl.formatList(days.map((d) => weekdayName(intl, d)))
    return intl.formatMessage(CADENCE_MESSAGES.onDays, { what, days: dayWords })
  }
  if (everyDay) return intl.formatMessage(CADENCE_MESSAGES.daily, { time: schedule.time })
  if (weekdays) return intl.formatMessage(CADENCE_MESSAGES.weekdays, { time: schedule.time })
  if (weekends) return intl.formatMessage(CADENCE_MESSAGES.weekends, { time: schedule.time })
  return intl.formatMessage(CADENCE_MESSAGES.daysAt, { days: intl.formatList(days.map((d) => weekdayName(intl, d))), time: schedule.time })
}

/** A run's outcome, worded for the heartbeat or for a scheduled task. */
export const RUN_OUTCOME_MESSAGES = {
  heartbeat: defineMessages({
    silent: { id: "assistant.run.heartbeat.silent", defaultMessage: "Nothing new" },
    found: { id: "assistant.run.heartbeat.found", defaultMessage: "Reported" },
    partial: { id: "assistant.run.heartbeat.partial", defaultMessage: "Couldn't check" },
    failed: { id: "assistant.run.heartbeat.failed", defaultMessage: "Failed" },
  }),
  task: defineMessages({
    silent: { id: "assistant.run.task.silent", defaultMessage: "Nothing new" },
    found: { id: "assistant.run.task.found", defaultMessage: "Done" },
    partial: { id: "assistant.run.task.partial", defaultMessage: "Partly done" },
    failed: { id: "assistant.run.task.failed", defaultMessage: "Failed" },
  }),
}

/** Why the assistant can't run, in the app's language; the server's English when the reason is unknown. */
export function blockerText(intl: IntlShape, blocker: string, reason: AssistantBlockerReason | null | undefined): string {
  switch (reason?.kind) {
    case "unknown-agent":
      return intl.formatMessage(
        {
          id: "assistant.blocker.unknownAgent",
          defaultMessage: "The assistant can't run on \"{agent}\". Pick Operon, Claude Code, Codex or OpenCode in Settings → Assistant.",
        },
        { agent: reason.agent },
      )
    case "not-installed":
      return intl.formatMessage(
        {
          id: "assistant.blocker.notInstalled",
          defaultMessage: "{agent} is not installed on this computer. Install it, or pick another agent in Settings → Assistant.",
        },
        { agent: reason.agent },
      )
    case "no-model":
      return intl.formatMessage({
        id: "assistant.blocker.noModel",
        defaultMessage: "No model is set up for the assistant yet. Add a provider in Settings → AI Providers, then pick models in Settings → Assistant.",
      })
    default:
      return blocker
  }
}

/** An activity's summary, with the server's own fixed wordings translated (the agent's are left alone). */
export function activitySummary(intl: IntlShape, summary: string): string {
  if (summary === WORKING_SUMMARY) return intl.formatMessage({ id: "assistant.activity.working", defaultMessage: "Working…" })
  if (summary === INTERRUPTED_SUMMARY) {
    return intl.formatMessage({ id: "assistant.activity.interrupted", defaultMessage: "Interrupted when the app restarted" })
  }
  return summary
}

/** An audit or approval detail, with the server's "skipped while unattended" prefix translated. */
export function auditDetail(intl: IntlShape, detail: string): string {
  if (!detail.startsWith(UNATTENDED_SKIP_PREFIX)) return detail
  return intl.formatMessage(
    { id: "assistant.audit.skippedUnattended", defaultMessage: "Skipped while running unattended: {what}" },
    { what: detail.slice(UNATTENDED_SKIP_PREFIX.length) },
  )
}

/** A thread message, with the server's "something went wrong" lead-in translated (the error itself is left as is). */
export function messageText(intl: IntlShape, text: string): string {
  if (!text.startsWith(TURN_ERROR_PREFIX)) return text
  return intl.formatMessage(
    { id: "assistant.chat.turnError", defaultMessage: "Something went wrong on my side: {error}" },
    { error: text.slice(TURN_ERROR_PREFIX.length) },
  )
}
