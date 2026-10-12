import { useState } from "react"
import { Ban, CalendarClock, FileText, HeartPulse, Pause, Play, PlugZap, RotateCw, Trash2 } from "lucide-react"
import { FormattedMessage, useIntl, type IntlShape } from "react-intl"
import { NOTHING_TO_CHECK_NOTE } from "@shared/assistant"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AssistantSchedule, AssistantScheduleRun } from "./types"
import { formatClock, isSameDay } from "./shared"
import { cadenceLabel, dayLabel, RUN_OUTCOME_MESSAGES } from "./assistant-i18n"
import { PROFILE_FILE_META } from "./ProfileTab"
import { Empty } from "./ActivityTab"

interface ScheduleTabProps {
  schedules: AssistantSchedule[]
  quietStart: string
  quietEnd: string
  onToggle: (id: number, enabled: boolean) => void
  onDelete: (id: number) => void
  onRun: (id: number) => void
  onEditHeartbeat: () => void
  onOpenActivity: (id: string) => void
  /** Open a plugin to sign in. Absent where there is no Plugins page (the phone). */
  onConnectPlugin?: (pluginId: string) => void
  /** Have the heartbeat try a service it found it can't check (the plan changed…). */
  onRecheck: (service: string) => void
}

function when(intl: IntlShape, ms: number): string {
  return isSameDay(ms, Date.now()) ? formatClock(ms) : `${dayLabel(intl, ms)} ${formatClock(ms)}`
}

/** Heartbeat pinned on top, then the tasks the assistant set up from conversation. */
export function ScheduleTab({
  schedules,
  quietStart,
  quietEnd,
  onToggle,
  onDelete,
  onRun,
  onEditHeartbeat,
  onOpenActivity,
  onConnectPlugin,
  onRecheck,
}: ScheduleTabProps) {
  const intl = useIntl()
  const [expanded, setExpanded] = useState<number | null>(() => schedules.find((s) => s.builtin)?.id ?? null)

  if (schedules.length === 0) {
    return (
      <Empty
        text={intl.formatMessage({
          id: "assistant.schedule.empty",
          defaultMessage: "No scheduled tasks. Ask the assistant to set one up.",
        })}
      />
    )
  }
  const paused = intl.formatMessage({ id: "assistant.schedule.paused", defaultMessage: "Paused" })

  return (
    <div className="space-y-1 px-2 pb-4 pt-2">
      {schedules.map((s) => {
        const open = expanded === s.id
        const heartbeat = s.builtin === "heartbeat"
        const Icon = heartbeat ? HeartPulse : CalendarClock
        return (
          <div key={s.id} className={cn("rounded-lg transition-colors", open && "bg-muted/40")}>
            <button
              type="button"
              onClick={() => setExpanded(open ? null : s.id)}
              className={cn("flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left", !open && "hover:bg-secondary-hover")}
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60",
                  heartbeat && s.enabled ? "text-status-error" : "text-muted-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className={cn("truncate text-sm font-medium", s.enabled ? "text-foreground/90" : "text-muted-foreground")}>
                  {/* The heartbeat's name is ours; a task's is the assistant's, already in the user's language. */}
                  {heartbeat ? intl.formatMessage(PROFILE_FILE_META.heartbeat.title) : s.name}
                </div>
                <div className="text-xs text-muted-foreground">{s.enabled ? cadenceLabel(intl, s) : paused}</div>
              </div>
            </button>

            {open && (
              <div className="space-y-3 px-2 pb-3 pl-13">
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div>
                    {!s.enabled ? (
                      paused
                    ) : s.nextRunAt ? (
                      <FormattedMessage
                        id="assistant.schedule.nextRun"
                        defaultMessage="Next run: {day} {time}"
                        values={{ day: dayLabel(intl, s.nextRunAt), time: formatClock(s.nextRunAt) }}
                      />
                    ) : (
                      <FormattedMessage id="assistant.schedule.noNextRun" defaultMessage="No upcoming run" />
                    )}
                  </div>
                  {heartbeat ? (
                    <div className="text-muted-foreground/80">
                      <FormattedMessage
                        id="assistant.schedule.quietHours"
                        defaultMessage="Quiet {start}–{end}: only urgent things are said then, the rest waits for the morning."
                        values={{ start: quietStart, end: quietEnd }}
                      />
                    </div>
                  ) : (
                    s.prompt && <div className="line-clamp-3 text-muted-foreground/80">{s.prompt}</div>
                  )}
                </div>

                {heartbeat && s.notConnected?.length ? (
                  <NotConnected plugins={s.notConnected} onConnect={onConnectPlugin} />
                ) : null}
                {heartbeat && s.limited?.length ? <Limited services={s.limited} onRecheck={onRecheck} /> : null}

                <RunLog runs={s.runs} heartbeat={heartbeat} onOpenActivity={onOpenActivity} />

                {/* The heartbeat is what makes the assistant reach out at all, so it has no
                    off switch; what it watches is steered through heartbeat.md instead. */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {heartbeat && (
                    <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={onEditHeartbeat}>
                      <FileText className="h-3.5 w-3.5" />
                      <FormattedMessage id="assistant.schedule.editHeartbeat" defaultMessage="Edit heartbeat.md" />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => onRun(s.id)}>
                    <RotateCw className="h-3.5 w-3.5" />
                    <FormattedMessage id="assistant.schedule.runNow" defaultMessage="Run now" />
                  </Button>
                  {!heartbeat && (
                    <>
                      <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => onToggle(s.id, !s.enabled)}>
                        {s.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        {s.enabled ? (
                          <FormattedMessage id="assistant.schedule.pause" defaultMessage="Pause" />
                        ) : (
                          <FormattedMessage id="assistant.schedule.resume" defaultMessage="Resume" />
                        )}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => onDelete(s.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                        <FormattedMessage id="assistant.schedule.delete" defaultMessage="Delete" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Plugins the heartbeat skips because nobody signed in. A standing state, said once here rather
 * than as a "couldn't check" on every run; it goes away as soon as the plugin is connected.
 */
function NotConnected({ plugins, onConnect }: { plugins: NonNullable<AssistantSchedule["notConnected"]>; onConnect?: (pluginId: string) => void }) {
  const intl = useIntl()
  const names = intl.formatList(plugins.map((p) => p.name))
  return (
    <div className="space-y-2 rounded-lg border border-border/40 bg-background/40 p-3 text-xs">
      <div className="flex items-start gap-2">
        <PlugZap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warn" />
        <div className="min-w-0 text-muted-foreground">
          <span className="font-medium text-foreground/85">
            <FormattedMessage id="assistant.schedule.notConnected" defaultMessage="Not connected: {names}." values={{ names }} />
          </span>{" "}
          {onConnect ? (
            <FormattedMessage id="assistant.schedule.notConnectedHint" defaultMessage="The heartbeat can't check it until you sign in." />
          ) : (
            <FormattedMessage
              id="assistant.schedule.notConnectedHintPhone"
              defaultMessage="The heartbeat can't check it until you sign in from Plugins on your computer."
            />
          )}
        </div>
      </div>
      {onConnect && (
        <div className="flex flex-wrap gap-1.5 pl-5.5">
          {plugins.map((p) => (
            <Button key={p.pluginId} size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => onConnect(p.pluginId)}>
              <PlugZap className="h-3.5 w-3.5" />
              <FormattedMessage id="assistant.schedule.connect" defaultMessage="Connect {name}" values={{ name: p.name }} />
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Services the heartbeat found it can't check at all — the plan or permissions don't allow it.
 * Said once here, skipped by later checks; tried again on its own after a week, or right away
 * from here once the user has changed something.
 */
function Limited({ services, onRecheck }: { services: NonNullable<AssistantSchedule["limited"]>; onRecheck: (service: string) => void }) {
  const intl = useIntl()
  return (
    <div className="space-y-3 rounded-lg border border-border/40 bg-background/40 p-3 text-xs">
      {services.map((s) => (
        <div key={s.service} className="space-y-2">
          <div className="flex items-start gap-2">
            <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 text-muted-foreground">
              {/* The reason is the agent's own sentence; its full stop would double up with ours. */}
              <span className="font-medium text-foreground/85">
                <FormattedMessage id="assistant.schedule.cantCheck" defaultMessage="Can't check {name}:" values={{ name: s.name }} />
              </span>{" "}
              <FormattedMessage
                id="assistant.schedule.cantCheckReason"
                defaultMessage="{reason}. Skipped until {day}."
                values={{ reason: s.reason.replace(/[。.!！]+$/, ""), day: dayLabel(intl, s.until) }}
              />
            </div>
          </div>
          <div className="pl-5.5">
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => onRecheck(s.service)}>
              <RotateCw className="h-3.5 w-3.5" />
              <FormattedMessage id="assistant.schedule.checkAgain" defaultMessage="Check again" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

const OUTCOME_DOT: Record<AssistantScheduleRun["outcome"], string> = {
  silent: "bg-muted-foreground/40",
  found: "bg-accent-green",
  partial: "bg-accent-warm",
  failed: "bg-accent-red",
}

function RunLog({ runs, heartbeat, onOpenActivity }: { runs: AssistantScheduleRun[]; heartbeat: boolean; onOpenActivity: (id: string) => void }) {
  const intl = useIntl()
  if (runs.length === 0) {
    return (
      <div className="text-xs text-muted-foreground/70">
        <FormattedMessage id="assistant.schedule.noRuns" defaultMessage="No runs yet." />
      </div>
    )
  }
  const labels = heartbeat ? RUN_OUTCOME_MESSAGES.heartbeat : RUN_OUTCOME_MESSAGES.task
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] font-medium text-muted-foreground/80">
        <FormattedMessage id="assistant.schedule.recentRuns" defaultMessage="Recent runs" />
      </div>
      {runs.map((r) => {
        // An outcome this build doesn't know (a newer server) shows as plain text rather than
        // taking the page down — the phone app ships slower than the desktop.
        const known = r.outcome in OUTCOME_DOT
        const dot = known ? OUTCOME_DOT[r.outcome] : "bg-muted-foreground/40"
        const label = known ? intl.formatMessage(labels[r.outcome]) : r.outcome
        const note =
          r.note === NOTHING_TO_CHECK_NOTE
            ? intl.formatMessage({ id: "assistant.schedule.nothingToCheck", defaultMessage: "Nothing to check" })
            : r.note
        const body = (
          <>
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
            <span className="shrink-0 text-foreground/80">{label}</span>
            {note && (
              <span className="min-w-0 truncate text-muted-foreground" title={note}>
                · {note}
              </span>
            )}
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/70">{when(intl, r.at)}</span>
          </>
        )
        // A run that produced an activity opens it; a silent one has nothing more to show.
        return r.activityId ? (
          <button
            key={r.id}
            type="button"
            title={intl.formatMessage({ id: "assistant.viewActivity", defaultMessage: "View activity" })}
            onClick={() => onOpenActivity(r.activityId!)}
            className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs hover:bg-secondary-hover"
          >
            {body}
          </button>
        ) : (
          <div key={r.id} className="flex items-center gap-2 py-0.5 text-xs">
            {body}
          </div>
        )
      })}
    </div>
  )
}
