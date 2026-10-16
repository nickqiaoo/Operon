import { HeartPulse, CalendarClock } from "lucide-react"
import { useIntl } from "react-intl"
import { cn } from "@/lib/utils"
import type { ActivitySummary } from "./types"
import { codingAgentName } from "./CodingAgentCard"
import { ActivityStatusTile, formatClock, isSameDay } from "./shared"
import { AGENT_MESSAGES, activitySummary, dayLabel } from "./assistant-i18n"

interface ActivityTabProps {
  activities: ActivitySummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** The phone's page: bigger rows and day headings. */
  large?: boolean
}

/** Everything the assistant did — its workers and its own changes — newest first, grouped by day. */
export function ActivityTab({ activities, selectedId, onSelect, large }: ActivityTabProps) {
  const intl = useIntl()
  const sorted = [...activities].sort((a, b) => b.startedAt - a.startedAt)

  if (sorted.length === 0) {
    return (
      <Empty
        text={intl.formatMessage({
          id: "assistant.activity.empty",
          defaultMessage: "Nothing yet. Work the assistant does for you shows up here.",
        })}
      />
    )
  }

  return (
    <div className="space-y-1 px-2 pb-4">
      {sorted.map((a, i) => (
        <div key={a.id}>
          {(i === 0 || !isSameDay(sorted[i - 1].startedAt, a.startedAt)) && (
            <div className={large ? "px-3 pb-1.5 pt-5 text-lg font-semibold" : "heading-section px-2 pb-1 pt-3"}>
              {dayLabel(intl, a.startedAt)}
            </div>
          )}
          <button
            type="button"
            onClick={() => onSelect(a.id)}
            className={cn(
              "flex w-full items-start text-left transition-colors",
              large ? "gap-3.5 rounded-xl px-3 py-2.5 active:bg-secondary-active" : "gap-3 rounded-lg px-2 py-2",
              selectedId === a.id ? "bg-foreground/[0.07]" : "hover:bg-secondary-hover",
            )}
          >
            <ActivityStatusTile status={a.status} large={large} />
            <div className="min-w-0 flex-1">
              <div className={cn("truncate text-foreground/90", large ? "text-[17px] font-semibold leading-snug" : "text-sm font-medium")}>
                {a.title}
              </div>
              <div className={cn("line-clamp-2 text-muted-foreground", large ? "text-[15px] leading-snug" : "text-xs")}>
                {activitySummary(intl, a.summary)}
              </div>
              <div className={cn("mt-0.5 flex items-center gap-1 text-muted-foreground/70", large ? "text-[13px]" : "text-[11px]")}>
                {a.source === "heartbeat" && <HeartPulse className="h-3 w-3" />}
                {a.source === "schedule" && <CalendarClock className="h-3 w-3" />}
                {formatClock(a.startedAt)}
                {a.agent === "main" && (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    {intl.formatMessage(AGENT_MESSAGES.main)}
                  </>
                )}
                {a.coding && (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="truncate">
                      {codingAgentName(a.coding.providerId)} · {a.coding.projectName ? `${a.coding.projectName} / ` : ""}
                      {a.coding.workspaceName}
                    </span>
                  </>
                )}
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
