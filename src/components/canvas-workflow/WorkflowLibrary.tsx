import { useIntl } from "react-intl"
import { AlertCircle, Check, Loader2, Network, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { relativeTime } from "@/components/task/task-meta"
import type { CanvasWorkflowLastRun, CanvasWorkflowListItem } from "@/types/canvas-workflow"

/**
 * The landing view for the workflow page: what exists, where it lives, and how
 * each one last did.
 *
 * This is the page's entry point rather than the canvas. Dropping straight into
 * an editor picked an arbitrary workflow for the user and hid both the rest of
 * the library and which workspace it was filtered to — the list has to come
 * first for either to be visible.
 */

interface WorkflowLibraryProps {
  workflows: CanvasWorkflowListItem[]
  /** "project / workspace" for the current workspace; null when none is active. */
  workspaceLabel: string | null
  onOpen: (id: number) => void
  onNew: () => void
  onDelete: (id: number) => void
}

/** Run state as a label, sharing one row's worth of vertical space. */
function LastRunChip({ lastRun }: { lastRun?: CanvasWorkflowLastRun }) {
  const intl = useIntl()

  if (!lastRun) {
    return (
      <span className="text-xs text-muted-foreground/70">
        {intl.formatMessage({ id: "canvas.library.neverRun", defaultMessage: "Never run" })}
      </span>
    )
  }

  const when = relativeTime(lastRun.finishedAt ?? lastRun.startedAt)

  if (lastRun.status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-status-info">
        <Loader2 className="h-3 w-3 animate-spin" />
        {intl.formatMessage({ id: "canvas.library.running", defaultMessage: "Running" })}
      </span>
    )
  }

  if (lastRun.status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-status-error">
        <AlertCircle className="h-3 w-3" />
        {intl.formatMessage({ id: "canvas.library.failed", defaultMessage: "Failed {when} ago" }, { when })}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-status-ok">
      <Check className="h-3 w-3" />
      {intl.formatMessage({ id: "canvas.library.succeeded", defaultMessage: "Ran {when} ago" }, { when })}
    </span>
  )
}

export function WorkflowLibrary({
  workflows,
  workspaceLabel,
  onOpen,
  onNew,
  onDelete,
}: WorkflowLibraryProps) {
  const intl = useIntl()

  return (
    <div className="h-full overflow-y-auto">
      {/* Reading width, not the full window — a list of short rows stretched
          across a wide editor window loses its left edge as a scan line. */}
      <div className="mx-auto max-w-4xl px-8 py-8">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">
              {intl.formatMessage({ id: "canvas.library.title", defaultMessage: "Workflows" })}
            </h2>
            {/* The list is workspace-filtered server-side; saying so is what
                keeps a short list from reading as "my workflows are gone". */}
            <p className="mt-0.5 text-xs text-muted-foreground">
              {workspaceLabel
                ? intl.formatMessage(
                    { id: "canvas.library.scope", defaultMessage: "In {workspace} · {count, plural, one {# workflow} other {# workflows}}" },
                    { workspace: workspaceLabel, count: workflows.length }
                  )
                : intl.formatMessage(
                    { id: "canvas.library.scopeAll", defaultMessage: "All workspaces · {count, plural, one {# workflow} other {# workflows}}" },
                    { count: workflows.length }
                  )}
            </p>
          </div>
          <Button size="sm" variant="secondary" className="h-8 shrink-0 gap-1.5" onClick={onNew}>
            <Plus className="h-3.5 w-3.5" />
            {intl.formatMessage({ id: "canvas.library.new", defaultMessage: "New workflow" })}
          </Button>
        </div>

        {workflows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/60 px-6 py-14 text-center">
            <Network className="h-5 w-5 text-muted-foreground/40" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">
                {intl.formatMessage({ id: "canvas.library.empty.title", defaultMessage: "No workflows yet" })}
              </p>
              <p className="text-xs text-muted-foreground/70">
                {intl.formatMessage({
                  id: "canvas.library.empty.hint",
                  defaultMessage: "Chain agents into a graph and run them together.",
                })}
              </p>
            </div>
            <Button size="sm" variant="secondary" className="mt-1 h-8 gap-1.5" onClick={onNew}>
              <Plus className="h-3.5 w-3.5" />
              {intl.formatMessage({ id: "canvas.library.empty.new", defaultMessage: "New workflow" })}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {workflows.map((wf) => (
              <button
                key={wf.id}
                type="button"
                onClick={() => onOpen(wf.id)}
                className={cn(
                  "group flex w-full items-center gap-4 rounded-xl border border-border/60 bg-popover/95 px-4 py-3 text-left",
                  "shadow-card transition-colors hover:border-border hover:bg-muted/30 dark:border-border/35"
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{wf.name}</span>
                    {/* Legacy rows with no workspace show up in every workspace's
                        list — label them so the odd one out is explainable. */}
                    {wf.workspaceId == null && (
                      <span className="shrink-0 rounded-full border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {intl.formatMessage({ id: "canvas.library.global", defaultMessage: "All workspaces" })}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      {intl.formatMessage(
                        { id: "canvas.library.nodeCount", defaultMessage: "{count, plural, one {# node} other {# nodes}}" },
                        { count: wf.nodes.length }
                      )}
                    </span>
                    <span className="text-muted-foreground/40">·</span>
                    <span>
                      {intl.formatMessage(
                        { id: "canvas.library.edited", defaultMessage: "Edited {when} ago" },
                        { when: relativeTime(wf.updatedAt) }
                      )}
                    </span>
                  </div>
                </div>

                <LastRunChip lastRun={wf.lastRun} />

                <Button
                  asChild
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:text-status-error"
                >
                  {/* A span, not a nested <button>: this row is itself a button. */}
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={intl.formatMessage({ id: "common.delete", defaultMessage: "Delete" })}
                    onClick={(event) => {
                      event.stopPropagation()
                      onDelete(wf.id)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </span>
                </Button>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
