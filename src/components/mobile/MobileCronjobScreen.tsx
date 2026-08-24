import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, CalendarClock, Plus, RefreshCw } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { CronjobTask, CronjobUpsertInput } from "@/types/cronjob"
import { useProjectStore } from "@/stores/project-store"
import { CronjobListItem } from "@/components/cronjob/CronjobListItem"
import { CronjobEditorDialog } from "@/components/cronjob/CronjobEditorDialog"
import { CronjobHistoryPanel } from "@/components/cronjob/CronjobHistoryPanel"
import { toUpsertInput, type ProviderInfo } from "@/components/cronjob/cronjobUtils"
import { MobileSheet } from "./MobileSheet"

interface MobileCronjobScreenProps {
  onBack: () => void
}

/**
 * Scheduled tasks (cronjobs) on mobile. Cronjobs are global (not scoped to a
 * project/workspace), so this lives under "More". Reuses the desktop pieces
 * wholesale — {@link CronjobListItem}, {@link CronjobEditorDialog} and
 * {@link CronjobHistoryPanel} — in a single column; only the list shell and the
 * save/run/toggle/delete handlers (mirrored from CronjobPage) live here.
 */
export function MobileCronjobScreen({ onBack }: MobileCronjobScreenProps) {
  const intl = useIntl()
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)

  const [cronjobs, setCronjobs] = useState<CronjobTask[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<CronjobTask | null>(null)
  const [runningIds, setRunningIds] = useState<Set<number>>(new Set())
  const [historyJob, setHistoryJob] = useState<CronjobTask | null>(null)

  const loadData = async () => {
    setLoading(true)
    try {
      const [cronjobRes, providerRes] = await Promise.all([api.cronjobList(), api.getProviders()])
      setCronjobs(cronjobRes.cronjobs)
      setProviders(providerRes)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData()
  }, [])

  const sorted = useMemo(
    () =>
      [...cronjobs].sort(
        (a, b) => (a.nextRunAt ?? Number.POSITIVE_INFINITY) - (b.nextRunAt ?? Number.POSITIVE_INFINITY)
      ),
    [cronjobs]
  )

  const handleSave = async (input: CronjobUpsertInput) => {
    if (editing) {
      const result = await api.cronjobUpdate(editing.id, input)
      setCronjobs((prev) => prev.map((j) => (j.id === editing.id ? result.cronjob : j)))
    } else {
      const result = await api.cronjobCreate(input)
      setCronjobs((prev) => [result.cronjob, ...prev])
    }
    setEditorOpen(false)
    setEditing(null)
  }

  const handleDelete = async (job: CronjobTask) => {
    if (!window.confirm(intl.formatMessage({ id: "mobile.cron.deleteConfirm", defaultMessage: 'Delete schedule "{name}"?' }, { name: job.name }))) return
    await api.cronjobDelete(job.id)
    setCronjobs((prev) => prev.filter((j) => j.id !== job.id))
  }

  const handleToggle = async (job: CronjobTask, enabled: boolean) => {
    const result = await api.cronjobUpdate(job.id, { ...toUpsertInput(job), enabled })
    setCronjobs((prev) => prev.map((j) => (j.id === job.id ? result.cronjob : j)))
  }

  const handleRun = async (job: CronjobTask) => {
    setRunningIds((prev) => new Set(prev).add(job.id))
    try {
      const result = await api.cronjobRun(job.id)
      if (result.cronjob) {
        const updated = result.cronjob
        setCronjobs((prev) => prev.map((j) => (j.id === job.id ? updated : j)))
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
    <div
      className="flex h-full flex-col bg-background"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/50 px-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          <FormattedMessage id="mobile.tab.more" defaultMessage="More" />
        </button>
        <span className="ml-1 text-sm font-semibold text-foreground/90">
          <FormattedMessage id="mobile.cron.title" defaultMessage="Schedules" />
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void loadData()}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50"
            aria-label={intl.formatMessage({ id: "common.refresh", defaultMessage: "Refresh" })}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(null)
              setEditorOpen(true)
            }}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50"
            aria-label={intl.formatMessage({ id: "mobile.cron.newSchedule", defaultMessage: "New schedule" })}
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-6 text-center text-sm text-muted-foreground/70">
            <FormattedMessage id="mobile.cron.loading" defaultMessage="Loading schedules…" />
          </p>
        ) : sorted.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <CalendarClock className="size-7 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground/85">
              <FormattedMessage id="mobile.cron.emptyTitle" defaultMessage="No schedules yet" />
            </p>
            <p className="text-xs text-muted-foreground/70">
              <FormattedMessage
                id="mobile.cron.emptyDesc"
                defaultMessage="Create a scheduled task to run agents automatically."
              />
            </p>
          </div>
        ) : (
          <div className="space-y-2 p-3">
            {sorted.map((job) => (
              <CronjobListItem
                key={job.id}
                job={job}
                selected={false}
                onSelect={() => setHistoryJob(job)}
                onToggle={handleToggle}
                onRun={handleRun}
                onEdit={(j) => {
                  setEditing(j)
                  setEditorOpen(true)
                }}
                onDelete={handleDelete}
                running={runningIds.has(job.id)}
              />
            ))}
          </div>
        )}
      </div>

      <CronjobEditorDialog
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open)
          if (!open) setEditing(null)
        }}
        providers={providers}
        projects={projects}
        activeProjectId={activeProjectId ?? undefined}
        activeWorkspaceId={activeWorkspaceId ?? undefined}
        initial={editing}
        onSave={handleSave}
      />

      <MobileSheet
        open={!!historyJob}
        onClose={() => setHistoryJob(null)}
        title={intl.formatMessage({ id: "mobile.cron.history", defaultMessage: "History" })}
      >
        {historyJob && <CronjobHistoryPanel job={historyJob} onOpenChat={() => setHistoryJob(null)} />}
      </MobileSheet>
    </div>
  )
}
