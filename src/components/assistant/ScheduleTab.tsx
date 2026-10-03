import { useState } from "react"
import { CalendarClock, FileText, HeartPulse, Pause, Play, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ScheduleItem, ScheduleRun } from "./types"
import { formatClock, dayLabel, isSameDay } from "./shared"
import { Empty } from "./ActivityTab"

interface ScheduleTabProps {
  schedules: ScheduleItem[]
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  onEditHeartbeat: () => void
}

/** Heartbeat pinned on top, then the tasks the assistant set up from conversation. */
export function ScheduleTab({ schedules, onToggle, onDelete, onEditHeartbeat }: ScheduleTabProps) {
  const [expanded, setExpanded] = useState<string | null>("heartbeat")
  const sorted = [...schedules].sort((a, b) => (a.builtin ? -1 : b.builtin ? 1 : a.nextRunAt - b.nextRunAt))

  if (sorted.length === 0) return <Empty text="No scheduled tasks. Ask the assistant to set one up." />

  return (
    <div className="space-y-1 px-2 pb-4 pt-2">
      {sorted.map((s) => {
        const open = expanded === s.id
        const Icon = s.builtin === "heartbeat" ? HeartPulse : CalendarClock
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
                  s.builtin === "heartbeat" && s.enabled ? "text-status-error" : "text-muted-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className={cn("truncate text-sm font-medium", s.enabled ? "text-foreground/90" : "text-muted-foreground")}>
                  {s.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {s.enabled ? s.cadence : "Paused"}
                </div>
              </div>
            </button>

            {open && (
              <div className="space-y-3 px-2 pb-3 pl-13">
                <div className="text-xs text-muted-foreground">
                  {s.enabled ? `Next run ${dayLabel(s.nextRunAt).toLowerCase()} at ${formatClock(s.nextRunAt)}` : "Paused"}
                </div>

                <RunLog runs={s.runs} />

                {/* The heartbeat is what makes the assistant reach out at all, so it has no
                    off switch; what it watches is steered through heartbeat.md instead. */}
                <div className="flex items-center gap-1.5">
                  {s.builtin === "heartbeat" ? (
                    <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={onEditHeartbeat}>
                      <FileText className="h-3.5 w-3.5" />
                      Edit heartbeat.md
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => onToggle(s.id)}>
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

const OUTCOME: Record<ScheduleRun["outcome"], { dot: string; label: string }> = {
  silent: { dot: "bg-muted-foreground/40", label: "Nothing new" },
  found: { dot: "bg-accent-green", label: "Reported" },
  failed: { dot: "bg-accent-red", label: "Failed" },
}

function RunLog({ runs }: { runs: ScheduleRun[] }) {
  if (runs.length === 0) return <div className="text-xs text-muted-foreground/70">No runs yet.</div>
  const now = Date.now()
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground/80">Recent runs</div>
      {runs.map((r) => (
        <div key={r.id} className="flex items-center gap-2 text-xs">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", OUTCOME[r.outcome].dot)} />
          <span className="text-foreground/80">{OUTCOME[r.outcome].label}</span>
          {r.note && <span className="min-w-0 truncate text-muted-foreground">· {r.note}</span>}
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/70">
            {isSameDay(r.at, now) ? formatClock(r.at) : `${dayLabel(r.at)} ${formatClock(r.at)}`}
          </span>
        </div>
      ))}
    </div>
  )
}
