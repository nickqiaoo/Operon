import { useEffect, useState } from "react"
import { useIntl } from "react-intl"
import { CalendarClock, ExternalLink, Play, RefreshCw } from "lucide-react"
import type { CronjobExecutionHistoryItem, CronjobTask } from "@/types/cronjob"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { describeSchedule, formatDateTime } from "./cronjobUtils"

interface CronjobHistoryPanelProps {
  job: CronjobTask
  onOpenChat: (chatId: number, title: string, providerId?: string) => void
}

export function CronjobHistoryPanel({ job, onOpenChat }: CronjobHistoryPanelProps) {
  const intl = useIntl()
  const [history, setHistory] = useState<CronjobExecutionHistoryItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.cronjobHistory(job.id)
      .then((res) => setHistory(res.history))
      .finally(() => setLoading(false))
  }, [job.id])

  const handleOpenChat = (item: CronjobExecutionHistoryItem) => {
    if (!item.chatId) return
    onOpenChat(item.chatId, `${job.name} - ${new Date(item.timestamp).toLocaleString()}`, item.providerId)
  }

  return (
    <div className="h-full flex flex-col bg-muted/5">
      {/* Header */}
      <div className="px-8 py-6 border-b border-border/40 bg-background/50 backdrop-blur-md">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold tracking-tight text-foreground">{job.name}</h2>
              <Badge variant={job.enabled ? "default" : "secondary"} className="rounded-md px-2 font-normal">
                {job.enabled ? intl.formatMessage({ id: "cronjob.history.active", defaultMessage: "Active" }) : intl.formatMessage({ id: "cronjob.history.paused", defaultMessage: "Paused" })}
              </Badge>
            </div>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <CalendarClock className="h-4 w-4" />
                <span>{describeSchedule(job.schedule)}</span>
              </div>
              {job.nextRunAt && (
                <div className="flex items-center gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-border" />
                  <span>{intl.formatMessage({ id: "cronjob.history.nextRun", defaultMessage: "Next run: {time}" }, { time: formatDateTime(job.nextRunAt) })}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Task Config Section */}
        {job.taskType === 'canvas-workflow' ? (
          <div className="px-8 py-6 border-b border-dashed border-border/40">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 mb-3 ml-1">{intl.formatMessage({ id: "cronjob.history.workflowSection", defaultMessage: "Workflow" })}</h3>
            <div className="bg-background rounded-xl p-5 border border-border/60 shadow-card">
              <div className="text-sm text-muted-foreground">{intl.formatMessage({ id: "cronjob.history.workflowId", defaultMessage: "Workflow ID: " })}<span className="font-mono">{job.canvasWorkflowId}</span></div>
            </div>
          </div>
        ) : job.prompt ? (
          <div className="px-8 py-6 border-b border-dashed border-border/40">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 mb-3 ml-1">{intl.formatMessage({ id: "cronjob.history.promptConfig", defaultMessage: "Prompt Configuration" })}</h3>
            <div className="bg-background rounded-xl p-5 border border-border/60 shadow-card">
              <div className="text-sm font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">{job.prompt}</div>
            </div>
          </div>
        ) : null}

        {/* History List */}
        <div className="flex items-center justify-between px-8 py-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 ml-1">{intl.formatMessage({ id: "cronjob.history.executionHistory", defaultMessage: "Execution History" })}</div>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5 rounded-full hover:bg-background shadow-none hover:shadow-card transition-all" onClick={() => void api.cronjobHistory(job.id).then(res => setHistory(res.history))}>
            <RefreshCw className="h-3 w-3" /> {intl.formatMessage({ id: "common.refresh", defaultMessage: "Refresh" })}
          </Button>
        </div>

        <ScrollArea className="flex-1 px-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-40 gap-3 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin opacity-50" />
              <span className="text-sm">{intl.formatMessage({ id: "cronjob.history.loading", defaultMessage: "Loading history..." })}</span>
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground">
              <div className="size-16 rounded-2xl bg-muted/40 flex items-center justify-center mb-4">
                <Play className="h-6 w-6 opacity-40" />
              </div>
              <p className="text-sm font-medium">{intl.formatMessage({ id: "cronjob.history.empty", defaultMessage: "No executions yet" })}</p>
              <p className="text-xs text-muted-foreground/60 mt-1">{intl.formatMessage({ id: "cronjob.history.emptyHint", defaultMessage: "Run the job manually or wait for the schedule." })}</p>
            </div>
          ) : (
            <div className="flex flex-col space-y-1 pb-6">
              {history.map((item) => (
                <div
                  key={`${item.chatId ?? 'no-chat'}-${item.timestamp}`}
                  className="px-4 py-3 rounded-xl border border-transparent hover:border-border/50 hover:bg-background hover:shadow-card transition-all flex items-center justify-between group"
                >
                  <div className="flex items-center gap-4">
                    <div className={cn(
                      "size-2.5 rounded-full shadow-card ring-2 ring-background",
                      item.status === "success" ? "bg-green-500" : item.status === "error" ? "bg-red-500" : "bg-yellow-500"
                    )} />
                    <div>
                      <div className="font-medium text-sm text-foreground">
                        {new Date(item.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="secondary" className="text-[10px] px-1.5 h-4 font-normal bg-muted/50 text-muted-foreground border-transparent">
                          {item.status}
                        </Badge>
                        {item.model && (
                          <span className="text-xs text-muted-foreground/60 flex items-center gap-1">· {item.model}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {item.chatId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="opacity-0 group-hover:opacity-100 transition-all gap-2 h-8 text-xs font-medium rounded-lg border border-border/50 hover:bg-background hover:shadow-card"
                      onClick={() => handleOpenChat(item)}
                    >
                      {intl.formatMessage({ id: "cronjob.history.openChat", defaultMessage: "Open Chat" })}
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  ) : (
                    <div className="text-xs text-muted-foreground/60">{intl.formatMessage({ id: "cronjob.history.noChat", defaultMessage: "No chat" })}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  )
}
