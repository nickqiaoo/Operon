import { useEffect, useMemo, useState } from "react"
import { useIntl } from "react-intl"
import { ArrowLeft, CalendarClock, Plus, RefreshCw } from "lucide-react"
import type { CronjobTask, CronjobUpsertInput } from "@/types/cronjob"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useProjectStore } from "@/stores/project-store"
import { CronjobListItem } from "./CronjobListItem"
import { CronjobHistoryPanel } from "./CronjobHistoryPanel"
import { CronjobEditorDialog } from "./CronjobEditorDialog"
import { toUpsertInput, type ProviderInfo } from "./cronjobUtils"

interface CronjobPageProps {
  onBack: () => void
  onOpenChat: (chatId: number, title: string, providerId?: string) => void
}

export function CronjobPage({ onBack, onOpenChat }: CronjobPageProps) {
  const intl = useIntl()
  const [cronjobs, setCronjobs] = useState<CronjobTask[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<CronjobTask | null>(null)
  const [runningIds, setRunningIds] = useState<Set<number>>(new Set())
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null)
  const projects = useProjectStore((state) => state.projects)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const activeWorkspaceId = useProjectStore((state) => state.activeWorkspaceId)

  const loadData = async () => {
    setLoading(true)
    try {
      const [cronjobRes, providerRes] = await Promise.all([
        api.cronjobList(),
        api.getProviders(),
      ])
      setCronjobs(cronjobRes.cronjobs)
      setProviders(providerRes)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadData() }, [])

  const sortedCronjobs = useMemo(() =>
    [...cronjobs].sort((a, b) => (a.nextRunAt ?? Number.POSITIVE_INFINITY) - (b.nextRunAt ?? Number.POSITIVE_INFINITY)),
    [cronjobs]
  )

  const selectedJob = useMemo(() => cronjobs.find((j) => j.id === selectedJobId) ?? null, [cronjobs, selectedJobId])

  const handleSave = async (input: CronjobUpsertInput) => {
    if (editing) {
      const result = await api.cronjobUpdate(editing.id, input)
      setCronjobs((prev) => prev.map((job) => (job.id === editing.id ? result.cronjob : job)))
    } else {
      const result = await api.cronjobCreate(input)
      setCronjobs((prev) => [result.cronjob, ...prev])
      setSelectedJobId(result.cronjob.id)
    }
    setEditorOpen(false)
    setEditing(null)
  }

  const handleDelete = async (job: CronjobTask) => {
    const confirmed = window.confirm(intl.formatMessage({ id: "cronjob.page.deleteConfirm", defaultMessage: 'Delete schedule "{name}"?' }, { name: job.name }))
    if (!confirmed) return
    await api.cronjobDelete(job.id)
    setCronjobs((prev) => prev.filter((item) => item.id !== job.id))
    if (selectedJobId === job.id) setSelectedJobId(null)
  }

  const handleToggle = async (job: CronjobTask, enabled: boolean) => {
    const result = await api.cronjobUpdate(job.id, { ...toUpsertInput(job), enabled })
    setCronjobs((prev) => prev.map((item) => (item.id === job.id ? result.cronjob : item)))
  }

  const handleRun = async (job: CronjobTask) => {
    setRunningIds((prev) => new Set(prev).add(job.id))
    try {
      const result = await api.cronjobRun(job.id)
      if (result.cronjob) {
        setCronjobs((prev) => prev.map((item) => (item.id === job.id ? result.cronjob! : item)))
      }
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev)
        next.delete(job.id)
        return next
      })
    }
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground">
      <div className="h-10 drag-region shrink-0 bg-background" />
      <div className="h-14 border-b border-border/40 flex items-center justify-between px-6 bg-background/80 backdrop-blur-md sticky top-0 z-10 no-drag">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground -ml-2 rounded-full px-3" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
            <span className="font-medium">{intl.formatMessage({ id: "common.back", defaultMessage: "Back" })}</span>
          </Button>
          <div className="h-4 w-[1px] bg-border/60" />
          <h1 className="text-lg font-semibold tracking-tight">{intl.formatMessage({ id: "cronjob.page.title", defaultMessage: "Schedules" })}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="rounded-full hover:bg-muted" onClick={() => void loadData()} title={intl.formatMessage({ id: "common.refresh", defaultMessage: "Refresh" })}>
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
          </Button>
          <Button variant="secondary" onClick={() => { setEditing(null); setEditorOpen(true) }} className="gap-2 h-9 px-4">
            <Plus className="h-4 w-4" />
            {intl.formatMessage({ id: "cronjob.page.newSchedule", defaultMessage: "New Schedule" })}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 animate-pulse">
            <div className="size-8 rounded-full bg-muted" />
            <div className="text-sm text-muted-foreground">{intl.formatMessage({ id: "cronjob.page.loading", defaultMessage: "Loading schedules..." })}</div>
          </div>
        </div>
      ) : sortedCronjobs.length === 0 ? (
        <div className="flex-1 flex items-center justify-center bg-muted/10">
          <div className="flex flex-col items-center justify-center gap-4 text-center p-8 max-w-sm">
            <div className="size-16 rounded-2xl bg-muted/40 flex items-center justify-center border border-border/60">
              <CalendarClock className="h-8 w-8 text-muted-foreground/60" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">{intl.formatMessage({ id: "cronjob.page.empty.title", defaultMessage: "No schedules yet" })}</h3>
              <p className="text-xs text-muted-foreground">{intl.formatMessage({ id: "cronjob.page.empty.hint", defaultMessage: "Create your first scheduled task to run AI agents automatically." })}</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <ResizablePanelGroup direction="horizontal" className="h-full">
            <ResizablePanel defaultSize="35%" minSize="25%" maxSize="45%" className="bg-muted/10">
              <div className="h-full flex flex-col">
                <div className="px-4 py-3 pb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  <CalendarClock className="h-3.5 w-3.5" />
                  <span>{intl.formatMessage({ id: "cronjob.page.activeSchedules", defaultMessage: "{count} Active Schedules" }, { count: sortedCronjobs.length })}</span>
                </div>
                <ScrollArea className="flex-1 px-2 pb-2">
                  <div className="space-y-1">
                    {sortedCronjobs.map((job) => (
                      <CronjobListItem
                        key={job.id}
                        job={job}
                        selected={selectedJobId === job.id}
                        onSelect={() => setSelectedJobId(job.id)}
                        onToggle={handleToggle}
                        onRun={handleRun}
                        onEdit={(j) => { setEditing(j); setEditorOpen(true) }}
                        onDelete={handleDelete}
                        running={runningIds.has(job.id)}
                      />
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </ResizablePanel>

            <ResizableHandle className="bg-border/60 hover:bg-tint/50 transition-colors w-[1px]" />

            <ResizablePanel defaultSize="65%" minSize="35%">
              {selectedJob ? (
                <CronjobHistoryPanel job={selectedJob} onOpenChat={onOpenChat} />
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-4 bg-muted/5">
                  <div className="size-20 rounded-full bg-muted/30 flex items-center justify-center">
                    <CalendarClock className="h-10 w-10 opacity-20" />
                  </div>
                  <div className="text-center space-y-1">
                    <p className="font-medium">{intl.formatMessage({ id: "cronjob.page.selectSchedule", defaultMessage: "Select a schedule" })}</p>
                    <p className="text-sm text-muted-foreground/60">{intl.formatMessage({ id: "cronjob.page.selectScheduleHint", defaultMessage: "View details and execution history" })}</p>
                  </div>
                </div>
              )}
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}

      <CronjobEditorDialog
        open={editorOpen}
        onOpenChange={(openValue) => { setEditorOpen(openValue); if (!openValue) setEditing(null) }}
        providers={providers}
        projects={projects}
        activeProjectId={activeProjectId ?? undefined}
        activeWorkspaceId={activeWorkspaceId ?? undefined}
        initial={editing}
        onSave={handleSave}
      />
    </div>
  )
}
