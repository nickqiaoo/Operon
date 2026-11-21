import { useIntl } from 'react-intl'
import { FolderGit2, GitBranchPlus } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useProjectStore } from '@/stores/project-store'
import { cn } from '@/lib/utils'
import type { TaskWorkspaceMode } from '@/types/task'

/**
 * Where a dispatched task runs: a new worktree of its own (the default — merged
 * on Done, removed afterwards) or the project's existing workspace (nothing
 * merged or removed). Picked before dispatch; read-only once it runs.
 */
export function TaskWorkspaceSelect({
  value,
  onChange,
  className,
}: {
  /** null: not chosen yet (a sub-task proposal the person still has to complete). */
  value: TaskWorkspaceMode | null
  onChange: (mode: TaskWorkspaceMode) => void
  className?: string
}) {
  const intl = useIntl()
  return (
    <Select value={value ?? ''} onValueChange={(v) => onChange(v === 'shared' ? 'shared' : 'new')}>
      <SelectTrigger className={cn('h-8 w-auto gap-1.5 bg-muted/30 border-border/50 text-xs', className)}>
        <SelectValue placeholder={intl.formatMessage({ id: 'task.workspace.choose', defaultMessage: 'Choose workspace' })} />
      </SelectTrigger>
      <SelectContent position="popper" align="start" sideOffset={6}>
        <SelectItem value="new">
          <span className="flex items-center gap-2">
            <GitBranchPlus className="h-3.5 w-3.5 text-muted-foreground" />
            {intl.formatMessage({ id: 'task.workspace.new', defaultMessage: 'New worktree' })}
          </span>
        </SelectItem>
        <SelectItem value="shared">
          <span className="flex items-center gap-2">
            <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
            {intl.formatMessage({ id: 'task.workspace.shared', defaultMessage: 'Shared workspace' })}
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  )
}

/**
 * Where a task that already runs is running — read-only, styled like the
 * Branch row beside it. A shared one names its workspace.
 */
export function TaskWorkspaceLabel({ mode, workspaceName }: { mode: TaskWorkspaceMode; workspaceName?: string | null }) {
  const intl = useIntl()
  const Icon = mode === 'shared' ? FolderGit2 : GitBranchPlus
  const label = mode === 'shared'
    ? intl.formatMessage({ id: 'task.workspace.shared', defaultMessage: 'Shared workspace' })
    : intl.formatMessage({ id: 'task.workspace.new', defaultMessage: 'New worktree' })
  const text = mode === 'shared' && workspaceName ? `${label} · ${workspaceName}` : label
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-muted/30 px-2 py-1.5 text-xs text-foreground/80" title={text}>
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{text}</span>
    </div>
  )
}

/** The name of the workspace a task runs in, from the sidebar's project list. */
export function useWorkspaceName(workspaceId: number | null): string | null {
  return useProjectStore((s) => {
    if (workspaceId == null) return null
    for (const project of s.projects) {
      const ws = project.workspaces.find((w) => w.id === workspaceId)
      if (ws) return ws.name
    }
    return null
  })
}
