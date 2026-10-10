import { useState } from "react"
import { CalendarClock, FileText, HeartPulse, Pause, Play, RotateCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AssistantSchedule, AssistantScheduleRun } from "./types"
import { formatClock, dayLabel, isSameDay } from "./shared"
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
}

function when(ms: number): string {
  return isSameDay(ms, Date.now()) ? formatClock(ms) : `${dayLabel(ms)} ${formatClock(ms)}`
}

/** "today at 08:00" / "tomorrow at 08:00" / "Mon, Oct 12 at 08:00". */
function nextRun(ms: number): string {
  const day = dayLabel(ms)
  return `${day === "Today" || day === "Tomorrow" ? day.toLowerCase() : day} at ${formatClock(ms)}`
}

/** Heartbeat pinned on top, then the tasks the assistant set up from conversation. */
export function ScheduleTab({ schedules, quietStart, quietEnd, onToggle, onDelete, onRun, onEditHeartbeat, onOpenActivity }: ScheduleTabProps) {
  const [expanded, setExpanded] = useState<number | null>(() => schedules.find((s) => s.builtin)?.id ?? null)

  if (schedules.length === 0) return <Empty text="No scheduled tasks. Ask the assistant to set one up." />

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
                  {s.name}
                </div>
                <div className="text-xs text-muted-foreground">{s.enabled ? s.cadence : "Paused"}</div>
              </div>
            </button>

            {open && (
              <div className="space-y-3 px-2 pb-3 pl-13">
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div>
                    {!s.enabled
                      ? "Paused"
                      : s.nextRunAt
                        ? `Next run ${nextRun(s.nextRunAt)}`
                        : "No upcoming run"}
                  </div>
                  {heartbeat ? (
                    <div className="text-muted-foreground/80">
                      Quiet {quietStart}–{quietEnd}: only urgent things are said then, the rest waits for the morning.
                    </div>
                  ) : (
                    s.prompt && <div className="line-clamp-3 text-muted-foreground/80">{s.prompt}</div>
                  )}
                </div>

                <RunLog runs={s.runs} heartbeat={heartbeat} onOpenActivity={onOpenActivity} />

                {/* The heartbeat is what makes the assistant reach out at all, so it has no
                    off switch; what it watches is steered through heartbeat.md instead. */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {heartbeat && (
                    <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={onEditHeartbeat}>
                      <FileText className="h-3.5 w-3.5" />
                      Edit heartbeat.md
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => onRun(s.id)}>
                    <RotateCw className="h-3.5 w-3.5" />
                    Run now
                  </Button>
                  {!heartbeat && (
                    <>
                      <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => onToggle(s.id, !s.enabled)}>
                        {s.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        {s.enabled ? "Pause" : "Resume"}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => onDelete(s.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
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

const OUTCOME: Record<AssistantScheduleRun["outcome"], { dot: string; heartbeat: string; task: string }> = {
  silent: { dot: "bg-muted-foreground/40", heartbeat: "Nothing new", task: "Nothing new" },
  found: { dot: "bg-accent-green", heartbeat: "Reported", task: "Done" },
  failed: { dot: "bg-accent-red", heartbeat: "Failed", task: "Failed" },
}

function RunLog({ runs, heartbeat, onOpenActivity }: { runs: AssistantScheduleRun[]; heartbeat: boolean; onOpenActivity: (id: string) => void }) {
  if (runs.length === 0) return <div className="text-xs text-muted-foreground/70">No runs yet.</div>
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] font-medium text-muted-foreground/80">Recent runs</div>
      {runs.map((r) => {
        const outcome = OUTCOME[r.outcome]
        const body = (
          <>
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", outcome.dot)} />
            <span className="shrink-0 text-foreground/80">{heartbeat ? outcome.heartbeat : outcome.task}</span>
            {r.note && <span className="min-w-0 truncate text-muted-foreground">· {r.note}</span>}
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/70">{when(r.at)}</span>
          </>
        )
        // A run that produced an activity opens it; a silent one has nothing more to show.
        return r.activityId ? (
          <button
            key={r.id}
            type="button"
            title="View activity"
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
