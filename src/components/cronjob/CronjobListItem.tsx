import { useIntl } from "react-intl"
import { CalendarClock, Pencil, Play, Trash2 } from "lucide-react"
import type { CronjobTask } from "@/types/cronjob"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { describeSchedule, formatDateTime } from "./cronjobUtils"

interface CronjobListItemProps {
  job: CronjobTask
  selected: boolean
  onSelect: () => void
  onToggle: (job: CronjobTask, enabled: boolean) => void
  onRun: (job: CronjobTask) => void
  onEdit: (job: CronjobTask) => void
  onDelete: (job: CronjobTask) => void
  running: boolean
}

export function CronjobListItem({
  job,
  selected,
  onSelect,
  onToggle,
  onRun,
  onEdit,
  onDelete,
  running,
}: CronjobListItemProps) {
  const intl = useIntl()
  return (
    <div
      className={cn(
        "group mx-2 my-1 rounded-xl border px-4 py-3 transition-all duration-200 ease-out cursor-pointer",
        selected
          ? "bg-muted/50 border-border/50"
          : "bg-transparent border-transparent hover:bg-muted/30"
      )}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={cn("text-sm font-medium truncate transition-colors", selected ? "text-tint" : "text-foreground")}>
              {job.name}
            </span>
            {job.taskType === 'canvas-workflow' && (
              <Badge variant="secondary" className="text-[10px] px-1.5 h-4 font-normal border-transparent shrink-0">
                {intl.formatMessage({ id: "cronjob.listItem.workflow", defaultMessage: "Workflow" })}
              </Badge>
            )}
            {job.lastResult && (
              <span
                className={cn(
                  "flex h-2 w-2 rounded-full ring-1 ring-background/50",
                  job.lastResult.status === "success" ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]" : "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]"
                )}
                title={`Last run: ${job.lastResult.status}`}
              />
            )}
          </div>

          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="h-3 w-3 opacity-70" />
              <span className="font-medium">{describeSchedule(job.schedule)}</span>
            </div>
            {job.nextRunAt && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                <Play className="h-3 w-3 opacity-70" />
                <span>{intl.formatMessage({ id: "cronjob.listItem.next", defaultMessage: "Next: {time}" }, { time: formatDateTime(job.nextRunAt) })}</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          <Switch
            checked={job.enabled}
            onCheckedChange={(val) => onToggle(job, val)}
            onClick={(e) => e.stopPropagation()}
          />

          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity -mr-1">
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-background/80" onClick={(e) => { e.stopPropagation(); onRun(job) }} disabled={running} title={intl.formatMessage({ id: "cronjob.listItem.runNow", defaultMessage: "Run now" })}>
              <Play className={cn("h-3.5 w-3.5", running && "animate-pulse")} />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-background/80" onClick={(e) => { e.stopPropagation(); onEdit(job) }} title={intl.formatMessage({ id: "common.edit", defaultMessage: "Edit" })}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={(e) => { e.stopPropagation(); onDelete(job) }} title={intl.formatMessage({ id: "common.delete", defaultMessage: "Delete" })}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
