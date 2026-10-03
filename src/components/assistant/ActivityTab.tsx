import { HeartPulse, CalendarClock } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Activity } from "./types"
import { ActivityStatusTile, dayLabel, formatClock, isSameDay } from "./shared"

interface ActivityTabProps {
  activities: Activity[]
  selectedId: string | null
  onSelect: (id: string) => void
}

/** Every worker the assistant ran, newest first, grouped by day. */
export function ActivityTab({ activities, selectedId, onSelect }: ActivityTabProps) {
  const sorted = [...activities].sort((a, b) => b.startedAt - a.startedAt)

  if (sorted.length === 0) {
    return <Empty text="Nothing yet. Work the assistant does for you shows up here." />
  }

  return (
    <div className="space-y-1 px-2 pb-4">
      {sorted.map((a, i) => (
        <div key={a.id}>
          {(i === 0 || !isSameDay(sorted[i - 1].startedAt, a.startedAt)) && (
            <div className="heading-section px-2 pb-1 pt-3">{dayLabel(a.startedAt)}</div>
          )}
          <button
            type="button"
            onClick={() => onSelect(a.id)}
            className={cn(
              "flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors",
              selectedId === a.id ? "bg-foreground/[0.07]" : "hover:bg-secondary-hover",
            )}
          >
            <ActivityStatusTile status={a.status} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground/90">{a.title}</div>
              <div className="line-clamp-2 text-xs text-muted-foreground">{a.summary}</div>
              <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground/70">
                {a.source === "heartbeat" && <HeartPulse className="h-3 w-3" />}
                {a.source === "schedule" && <CalendarClock className="h-3 w-3" />}
                {formatClock(a.startedAt)}
              </div>
            </div>
          </button>
        </div>
      ))}
    </div>
  )
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="mx-4 mt-4 rounded-xl border border-dashed border-border/50 px-4 py-8 text-center text-xs text-muted-foreground">
      {text}
    </div>
  )
}
