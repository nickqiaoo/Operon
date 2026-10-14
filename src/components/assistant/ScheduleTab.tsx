import { useState } from "react"
import { CalendarClock, HeartPulse, ListChecks, Pause, Pencil, Play, PlugZap, RotateCw, Trash2 } from "lucide-react"
import { FormattedMessage, useIntl, type IntlShape } from "react-intl"
import { heartbeatChecks, NOTHING_TO_CHECK_NOTE } from "@shared/assistant"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { AssistantSchedule, AssistantScheduleRun } from "./types"
import { formatClock, isSameDay } from "./shared"
import { cadenceLabel, dayLabel, HEARTBEAT_TITLE, RUN_OUTCOME_MESSAGES } from "./assistant-i18n"
import { Empty } from "./ActivityTab"

interface ScheduleTabProps {
  schedules: AssistantSchedule[]
  quietStart: string
  quietEnd: string
  onToggle: (id: number, enabled: boolean) => void
  onDelete: (id: number) => void
  onRun: (id: number) => void
  onOpenActivity: (id: string) => void
  /** Open a plugin to sign in. Absent where there is no Plugins page (the phone). */
  onConnectPlugin?: (pluginId: string) => void
  /** heartbeat.md, whose sections are the heartbeat's checks. */
  checklist: string
  /** Open heartbeat.md in the editor. */
  onOpenChecklist: () => void
}

function when(intl: IntlShape, ms: number): string {
  return isSameDay(ms, Date.now()) ? formatClock(ms) : `${dayLabel(intl, ms)} ${formatClock(ms)}`
}

/** Heartbeat pinned on top, then the tasks the assistant set up from conversation. One line each; the rest is in a dialog. */
export function ScheduleTab({
  schedules,
  quietStart,
  quietEnd,
  onToggle,
  onDelete,
  onRun,
  onOpenActivity,
  onConnectPlugin,
  checklist,
  onOpenChecklist,
}: ScheduleTabProps) {
  const intl = useIntl()
  // By id, not by value: the schedule keeps updating (next run, new runs) while the dialog is open.
  const [openId, setOpenId] = useState<number | null>(null)
  const open = schedules.find((s) => s.id === openId)

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

  return (
    <div className="space-y-0.5 px-2 pb-4 pt-2">
      {schedules.map((s) => {
        const heartbeat = s.builtin === "heartbeat"
        const Icon = heartbeat ? HeartPulse : CalendarClock
        // A standing problem must not hide behind the click: mark the row.
        const attention = heartbeat && Boolean(s.notConnected?.length)
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => setOpenId(s.id)}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-secondary-hover"
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
                {scheduleName(intl, s)}
              </div>
              <div className="truncate text-xs text-muted-foreground">{subtitle(intl, s)}</div>
            </div>
            {attention && <PlugZap className="h-3.5 w-3.5 shrink-0 text-status-warn" />}
          </button>
        )
      })}

      <Dialog open={open !== undefined} onOpenChange={(next) => !next && setOpenId(null)}>
        {open && (
          <ScheduleDialog
            schedule={open}
            quietStart={quietStart}
            quietEnd={quietEnd}
            onToggle={onToggle}
            onDelete={(id) => {
              setOpenId(null)
              onDelete(id)
            }}
            onRun={onRun}
            onOpenActivity={(id) => {
              // The activity opens in its own drawer; two layers stacked would fight for focus.
              setOpenId(null)
              onOpenActivity(id)
            }}
            onConnectPlugin={onConnectPlugin}
            checklist={checklist}
            onOpenChecklist={() => {
              // The file opens in its own drawer; same as an activity, one layer at a time.
              setOpenId(null)
              onOpenChecklist()
            }}
          />
        )}
      </Dialog>
    </div>
  )
}

/** The heartbeat's name is ours; a task's is the assistant's, already in the user's language. */
function scheduleName(intl: IntlShape, s: AssistantSchedule): string {
  return s.builtin === "heartbeat" ? intl.formatMessage(HEARTBEAT_TITLE) : s.name
}

function subtitle(intl: IntlShape, s: AssistantSchedule): string {
  return s.enabled ? cadenceLabel(intl, s) : intl.formatMessage({ id: "assistant.schedule.paused", defaultMessage: "Paused" })
}

/** How many runs show before "Show more". */
const RUNS_COLLAPSED = 5

function ScheduleDialog({
  schedule: s,
  quietStart,
  quietEnd,
  onToggle,
  onDelete,
  onRun,
  onOpenActivity,
  onConnectPlugin,
  checklist,
  onOpenChecklist,
}: Omit<ScheduleTabProps, "schedules"> & { schedule: AssistantSchedule }) {
  const intl = useIntl()
  const heartbeat = s.builtin === "heartbeat"

  return (
    <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-md">
      <DialogHeader className="text-left">
        <DialogTitle className="pr-6 text-base">{scheduleName(intl, s)}</DialogTitle>
        <DialogDescription>{subtitle(intl, s)}</DialogDescription>
      </DialogHeader>

      <div className="-mx-6 min-h-0 space-y-4 overflow-y-auto px-6">
        <div className="space-y-1 text-xs text-muted-foreground">
          {s.enabled && (
            <div>
              {s.nextRunAt ? (
                <FormattedMessage
                  id="assistant.schedule.nextRun"
                  defaultMessage="Next run: {day} {time}"
                  values={{ day: dayLabel(intl, s.nextRunAt), time: formatClock(s.nextRunAt) }}
                />
              ) : (
                <FormattedMessage id="assistant.schedule.noNextRun" defaultMessage="No upcoming run" />
              )}
            </div>
          )}
          {heartbeat ? (
            <div className="text-muted-foreground/80">
              <FormattedMessage
                id="assistant.schedule.quietHours"
                defaultMessage="Quiet {start}–{end}: only urgent things are said then, the rest waits for the morning."
                values={{ start: quietStart, end: quietEnd }}
              />
            </div>
          ) : (
            s.prompt && <div className="whitespace-pre-wrap text-muted-foreground/80">{s.prompt}</div>
          )}
        </div>

        {heartbeat && <Checklist checks={heartbeatChecks(checklist)} onOpen={onOpenChecklist} />}
        {heartbeat && s.notConnected?.length ? <NotConnected plugins={s.notConnected} onConnect={onConnectPlugin} /> : null}

        <RunLog runs={s.runs} heartbeat={heartbeat} onOpenActivity={onOpenActivity} />
      </div>

      {/* The heartbeat is what makes the assistant reach out at all, so it has no
          off switch; what it checks is heartbeat.md. */}
      <DialogFooter>
        {!heartbeat && (
          <>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => onDelete(s.id)}>
              <Trash2 className="h-3.5 w-3.5" />
              <FormattedMessage id="assistant.schedule.delete" defaultMessage="Delete" />
            </Button>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => onToggle(s.id, !s.enabled)}>
              {s.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {s.enabled ? (
                <FormattedMessage id="assistant.schedule.pause" defaultMessage="Pause" />
              ) : (
                <FormattedMessage id="assistant.schedule.resume" defaultMessage="Resume" />
              )}
            </Button>
          </>
        )}
        <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={() => onRun(s.id)}>
          <RotateCw className="h-3.5 w-3.5" />
          <FormattedMessage id="assistant.schedule.runNow" defaultMessage="Run now" />
        </Button>
      </DialogFooter>
    </DialogContent>
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
 * What the heartbeat checks: the sections of heartbeat.md. It looks at nothing else, so an empty
 * list means it only follows up on what is in progress.
 */
function Checklist({ checks, onOpen }: { checks: string[]; onOpen: () => void }) {
  const intl = useIntl()
  return (
    <div className="space-y-2 rounded-lg border border-border/40 bg-background/40 p-3 text-xs">
      <div className="flex items-start gap-2">
        <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 text-muted-foreground">
          {checks.length ? (
            <>
              <span className="font-medium text-foreground/85">
                <FormattedMessage id="assistant.schedule.checks" defaultMessage="Checks:" />
              </span>{" "}
              {intl.formatList(checks)}
            </>
          ) : (
            <FormattedMessage
              id="assistant.schedule.noChecks"
              defaultMessage="No checks yet. Ask the assistant to watch something for you, or add one to the checklist."
            />
          )}
        </div>
      </div>
      <div className="pl-5.5">
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={onOpen}>
          <Pencil className="h-3.5 w-3.5" />
          <FormattedMessage id="assistant.schedule.editChecklist" defaultMessage="Edit checklist" />
        </Button>
      </div>
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
  const [all, setAll] = useState(false)
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
      {(all ? runs : runs.slice(0, RUNS_COLLAPSED)).map((r) => {
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
      {!all && runs.length > RUNS_COLLAPSED && (
        <Button size="sm" variant="ghost" className="mt-1 h-7 w-full text-xs text-muted-foreground" onClick={() => setAll(true)}>
          <FormattedMessage id="assistant.schedule.showMoreRuns" defaultMessage="Show more" />
        </Button>
      )}
    </div>
  )
}
