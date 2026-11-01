import { useMemo, useState } from "react"
import { ArrowLeft, CalendarClock, Plus, RefreshCw } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { useCronjobActions, useCronjobs } from "@/lib/cronjob-queries"
import { useProviders, type ProviderSummary } from "@/lib/provider-queries"
import { cn } from "@/lib/utils"
import type { CronjobTask, CronjobUpsertInput } from "@/types/cronjob"
import { useProjectStore } from "@/stores/project-store"
import { CronjobListItem } from "@/components/cronjob/CronjobListItem"
import { CronjobEditorDialog } from "@/components/cronjob/CronjobEditorDialog"
import { CronjobHistoryPanel } from "@/components/cronjob/CronjobHistoryPanel"
import { MobileSheet } from "./MobileSheet"

const NO_CRONJOBS: CronjobTask[] = []
const NO_PROVIDERS: ProviderSummary[] = []

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

  const cronjobsQuery = useCronjobs()
  const providersQuery = useProviders()
  const cronjobs = cronjobsQuery.data ?? NO_CRONJOBS
  const providers = providersQuery.data ?? NO_PROVIDERS
  const loading = cronjobsQuery.isPending
  const { create, update, remove, setEnabled, run, runningIds } = useCronjobActions()
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<CronjobTask | null>(null)
  const [historyJob, setHistoryJob] = useState<CronjobTask | null>(null)

  const refresh = () => {
    void cronjobsQuery.refetch()
    void providersQuery.refetch()
  }

  const sorted = useMemo(
    () =>
      [...cronjobs].sort(
        (a, b) => (a.nextRunAt ?? Number.POSITIVE_INFINITY) - (b.nextRunAt ?? Number.POSITIVE_INFINITY)
      ),
    [cronjobs]
  )

  const handleSave = async (input: CronjobUpsertInput) => {
    if (editing) await update(editing.id, input)
    else await create(input)
    setEditorOpen(false)
    setEditing(null)
  }

  const handleDelete = async (job: CronjobTask) => {
    if (!window.confirm(intl.formatMessage({ id: "mobile.cron.deleteConfirm", defaultMessage: 'Delete schedule "{name}"?' }, { name: job.name }))) return
    await remove(job.id)
  }

  const handleToggle = async (job: CronjobTask, enabled: boolean) => {
    await setEnabled(job, enabled)
  }

  const handleRun = (job: CronjobTask) => run(job)

  return (
    <div
      className="flex h-full flex-col bg-background"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/50 px-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-base text-muted-foreground hover:bg-row-hover hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          <FormattedMessage id="mobile.tab.more" defaultMessage="More" />
        </button>
        <span className="ml-1 text-base font-semibold text-foreground/90">
          <FormattedMessage id="mobile.cron.title" defaultMessage="Schedules" />
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={refresh}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent-hover"
            aria-label={intl.formatMessage({ id: "common.refresh", defaultMessage: "Refresh" })}
          >
            <RefreshCw className={cn("size-4", cronjobsQuery.isFetching && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(null)
              setEditorOpen(true)
            }}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent-hover"
            aria-label={intl.formatMessage({ id: "mobile.cron.newSchedule", defaultMessage: "New schedule" })}
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-6 text-center text-base text-muted-foreground/70">
            <FormattedMessage id="mobile.cron.loading" defaultMessage="Loading schedules…" />
          </p>
        ) : sorted.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <CalendarClock className="size-7 text-muted-foreground/50" />
            <p className="text-base font-medium text-foreground/85">
              <FormattedMessage id="mobile.cron.emptyTitle" defaultMessage="No schedules yet" />
            </p>
            <p className="text-[13px] text-muted-foreground/70">
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
