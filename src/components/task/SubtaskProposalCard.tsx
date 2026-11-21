import { useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { AlertCircle, ChevronRight, Loader2, Split, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { formatRelativeTime } from '@/lib/format'
import { useTaskStore } from '@/stores/task-store'
import type { Agent } from '@/types/channel'
import type { SubtaskProposalItem, SubtaskProposalMeta, TaskActivity, TaskWorkspaceMode } from '@/types/task'
import { TaskWorkspaceSelect } from './TaskWorkspaceSelect'
import { toastTaskError } from './task-error-toast'

/**
 * A task's agent proposed handing parts of its work to other agents. The person
 * completes it here — every row needs an agent and a workspace — and confirms;
 * the server then creates and dispatches each row as a sub-task.
 */

export function readProposal(a: TaskActivity): SubtaskProposalMeta | null {
  const meta = a.meta
  if (a.kind !== 'system' || meta?.event !== 'subtasks.proposed' || !Array.isArray(meta.items)) return null
  const state = meta.state === 'confirmed' || meta.state === 'dismissed' ? meta.state : 'pending'
  return { event: 'subtasks.proposed', state, items: meta.items as SubtaskProposalItem[] }
}

interface Row {
  key: string
  title: string
  description: string
  assignedAgentId: number | null
  workspaceMode: TaskWorkspaceMode | null
}

const workspaceLabel = (intl: ReturnType<typeof useIntl>, mode: TaskWorkspaceMode | null) =>
  mode === 'shared'
    ? intl.formatMessage({ id: 'task.workspace.shared', defaultMessage: 'Shared workspace' })
    : intl.formatMessage({ id: 'task.workspace.new', defaultMessage: 'New worktree' })

export function SubtaskProposalCard({
  activity,
  proposal,
  taskId,
  agents,
}: {
  activity: TaskActivity
  proposal: SubtaskProposalMeta
  taskId: number
  agents: Agent[]
}) {
  const intl = useIntl()
  const openDetail = useTaskStore((s) => s.openDetail)
  const [rows, setRows] = useState<Row[]>(() =>
    proposal.items.map((item, index) => ({
      key: String(index),
      title: item.title,
      description: item.description,
      // A proposed agent that no longer exists is not a choice.
      assignedAgentId: item.assignedAgentId != null && agents.some((a) => a.id === item.assignedAgentId) ? item.assignedAgentId : null,
      workspaceMode: item.workspaceMode,
    })),
  )
  const [busy, setBusy] = useState<'confirm' | 'dismiss' | null>(null)
  const pending = proposal.state === 'pending'
  const complete = rows.length > 0 && rows.every((r) => r.title.trim() && r.assignedAgentId != null && r.workspaceMode != null)
  const agentName = (id: number | null) => agents.find((a) => a.id === id)?.name ?? null

  const patch = (key: string, next: Partial<Row>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...next } : r)))

  const resolve = async (action: 'confirm' | 'dismiss') => {
    setBusy(action)
    try {
      await api.taskResolveProposal(taskId, activity.id, action === 'dismiss'
        ? { action }
        : {
            action,
            items: rows.map((r) => ({
              title: r.title.trim(),
              description: r.description,
              assignedAgentId: r.assignedAgentId!,
              workspaceMode: r.workspaceMode!,
            })),
          })
      await openDetail(taskId)
    } catch (error) {
      toastTaskError(error, action === 'confirm' ? 'Could not start the sub-tasks' : 'Could not dismiss the proposal')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex items-start gap-3 py-2">
      <span className="relative z-[1] flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-foreground/80 ring-4 ring-background">
        <Split className="h-3 w-3" />
      </span>
      <div className="min-w-0 flex-1 rounded-lg border border-border/50 bg-popover shadow-card dark:border-border/35">
        <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-xs">
          <span className="font-medium text-foreground/85">{activity.actorName}</span>
          <span className="text-muted-foreground">
            <FormattedMessage
              id="task.proposal.title"
              defaultMessage="proposed {count, plural, one {# sub-task} other {# sub-tasks}}"
              values={{ count: proposal.items.length }}
            />
          </span>
          <span className="text-muted-foreground/60 tabular-nums">{formatRelativeTime(intl, activity.createdAt, { compact: true })}</span>
          {!pending && (
            <span className="ml-auto rounded border border-border/40 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {proposal.state === 'confirmed'
                ? intl.formatMessage({ id: 'task.proposal.confirmed', defaultMessage: 'Confirmed' })
                : intl.formatMessage({ id: 'task.proposal.dismissed', defaultMessage: 'Dismissed' })}
            </span>
          )}
        </div>

        {pending ? (
          <div className="divide-y divide-border/40">
            {rows.map((row) => (
              <div key={row.key} className="space-y-2 px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <input
                    data-bare
                    value={row.title}
                    onChange={(e) => patch(row.key, { title: e.target.value })}
                    aria-label={intl.formatMessage({ id: 'task.proposal.itemTitle', defaultMessage: 'Sub-task title' })}
                    className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none"
                  />
                  {rows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                      aria-label={intl.formatMessage({ id: 'task.proposal.removeItem', defaultMessage: 'Remove this sub-task' })}
                      className="rounded-md p-1 text-muted-foreground hover:bg-accent-hover hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {row.description && (
                  <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground" title={row.description}>
                    {row.description}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={row.assignedAgentId != null ? String(row.assignedAgentId) : ''}
                    onValueChange={(v) => patch(row.key, { assignedAgentId: Number(v) })}
                  >
                    <SelectTrigger className="h-8 w-auto gap-1.5 border-border/50 bg-muted/30 text-xs">
                      <SelectValue placeholder={intl.formatMessage({ id: 'task.proposal.chooseAgent', defaultMessage: 'Choose agent' })} />
                    </SelectTrigger>
                    <SelectContent position="popper" align="start" sideOffset={6}>
                      {agents.map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <TaskWorkspaceSelect value={row.workspaceMode} onChange={(workspaceMode) => patch(row.key, { workspaceMode })} />
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {complete
                  ? intl.formatMessage({ id: 'task.proposal.ready', defaultMessage: 'Each sub-task starts with its agent right away.' })
                  : intl.formatMessage({ id: 'task.proposal.incomplete', defaultMessage: 'Choose an agent and a workspace for every sub-task.' })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-8 gap-1.5"
                disabled={busy != null}
                onClick={() => void resolve('dismiss')}
              >
                {busy === 'dismiss' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <FormattedMessage id="task.proposal.dismiss" defaultMessage="Dismiss" />
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="h-8 gap-1.5"
                disabled={!complete || busy != null}
                onClick={() => void resolve('confirm')}
              >
                {busy === 'confirm' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <FormattedMessage id="task.proposal.confirm" defaultMessage="Confirm & Dispatch" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="py-1">
            {proposal.items.map((item, index) => (
              <button
                key={index}
                type="button"
                disabled={item.taskId == null}
                onClick={() => item.taskId != null && void openDetail(item.taskId)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-row-hover disabled:hover:bg-transparent"
              >
                {item.taskNumber != null && <span className="shrink-0 font-mono text-xs text-muted-foreground">#{item.taskNumber}</span>}
                <span className="min-w-0 flex-1 truncate text-foreground/85">{item.title}</span>
                {item.error ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-status-error" title={item.error}>
                    <AlertCircle className="h-3.5 w-3.5" />
                    <FormattedMessage id="task.proposal.notStarted" defaultMessage="Not started" />
                  </span>
                ) : (
                  proposal.state === 'confirmed' && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {agentName(item.assignedAgentId) ? `@${agentName(item.assignedAgentId)} · ` : ''}
                      {workspaceLabel(intl, item.workspaceMode)}
                    </span>
                  )
                )}
                {item.taskId != null && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
