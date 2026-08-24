import { useEffect, useMemo, useState } from 'react'
import { Plus, List as ListIcon, LayoutGrid, Loader2, Users, Archive } from 'lucide-react'
import { useIntl } from 'react-intl'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useTaskStore } from '@/stores/task-store'
import { useChannelStore } from '@/stores/channel-store'
import { useTaskStream } from '@/hooks/useTaskStream'
import { TaskListView } from './TaskListView'
import { TaskBoardView } from './TaskBoardView'
import { TaskTeamsView } from './TaskTeamsView'
import { TaskDetailView } from './TaskDetailView'
import { NewTaskDialog } from './NewTaskDialog'
import { StatusIcon, PriorityIcon, AssigneeAvatar, type TaskGroup } from './task-meta'
import {
  TASK_STATUSES,
  TASK_PRIORITIES,
  isValidTaskTransition,
} from '@/types/task'
import { STATUS_MESSAGES, priorityMessage } from './task-i18n'
import { toastTaskError } from './task-error-toast'
import type { TaskListItem, TaskStatus, TaskPriority } from '@/types/task'

interface TasksPageProps {
  projectId: number
  onOpenWorkspace?: (workspaceId: number) => void
  /** Deep-link target (e.g. from an inbox notification): open this task's detail
   *  once, after the initial load. Cleared via {@link onInitialTaskConsumed}. */
  initialTaskId?: number | null
  onInitialTaskConsumed?: () => void
}

type GroupBy = 'status' | 'priority' | 'assignee' | 'team'
type ViewMode = 'list' | 'board' | 'teams'

export function TasksPage({ projectId, onOpenWorkspace, initialTaskId, onInitialTaskConsumed }: TasksPageProps) {
  const intl = useIntl()
  const tasks = useTaskStore((s) => s.tasks)
  const teams = useTaskStore((s) => s.teams)
  const detail = useTaskStore((s) => s.detail)
  const loading = useTaskStore((s) => s.loading)
  const load = useTaskStore((s) => s.load)
  const openDetail = useTaskStore((s) => s.openDetail)
  const closeDetail = useTaskStore((s) => s.closeDetail)
  const update = useTaskStore((s) => s.update)
  const dispatch = useTaskStore((s) => s.dispatch)
  const createTeam = useTaskStore((s) => s.createTeam)
  const updateTeam = useTaskStore((s) => s.updateTeam)
  const deleteTeam = useTaskStore((s) => s.deleteTeam)
  const agents = useChannelStore((s) => s.agents)
  const sessions = useChannelStore((s) => s.sessions)
  const [view, setView] = useState<ViewMode>('list')
  const [groupBy, setGroupBy] = useState<GroupBy>('status')
  const [showNew, setShowNew] = useState(false)
  const [fStatus, setFStatus] = useState<string>('all')
  const [fAssignee, setFAssignee] = useState<string>('all')
  const [fPriority, setFPriority] = useState<string>('all')
  const [fTeam, setFTeam] = useState<string>('all')
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    void load(projectId)
  }, [projectId, load])

  // Deep-link: open the requested task's detail once. Declared AFTER the load
  // effect so load()'s synchronous `detail: null` (at its start) runs first;
  // load's completion never touches `detail`, so openDetail's result survives.
  useEffect(() => {
    if (initialTaskId == null) return
    void openDetail(initialTaskId)
    onInitialTaskConsumed?.()
  }, [initialTaskId, openDetail, onInitialTaskConsumed])

  // Live updates: agent (or other-window) task changes stream in via SSE.
  useTaskStream(projectId)

  const archivedCount = useMemo(() => tasks.filter((t) => t.archivedAt != null).length, [tasks])

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      // Archived tasks are hidden unless the "Show archived" toggle is on.
      if (!showArchived && t.archivedAt != null) return false
      if (fStatus !== 'all' && t.status !== fStatus) return false
      if (fAssignee !== 'all') {
        const ok =
          fAssignee === 'unassigned'
            ? t.assignedAgentId == null
            : t.assignedAgentId === Number(fAssignee)
        if (!ok) return false
      }
      if (fPriority !== 'all' && t.priority !== Number(fPriority)) return false
      if (fTeam !== 'all') {
        const ok = fTeam === 'none' ? t.teamId == null : t.teamId === Number(fTeam)
        if (!ok) return false
      }
      return true
    })
  }, [tasks, fStatus, fAssignee, fPriority, fTeam, showArchived])

  // Grouping axis for List sections / Board columns.
  const groups: TaskGroup[] = useMemo(() => {
    if (groupBy === 'team') {
      return [
        {
          key: 'none',
          label: 'No team',
          accent: <Users className="w-3.5 h-3.5 text-muted-foreground/50" />,
        },
        ...teams.map((t) => ({
          key: String(t.id),
          label: t.name,
          accent: (
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
          ),
        })),
      ]
    }
    if (groupBy === 'priority') {
      // Urgent first (priority DESC), matching the type's documented sort order.
      return [...TASK_PRIORITIES].reverse().map((p) => ({
        key: String(p),
        label: intl.formatMessage(priorityMessage(p)),
        accent: <PriorityIcon priority={p} />,
      }))
    }
    if (groupBy === 'assignee') {
      return [
        {
          key: 'unassigned',
          label: 'Unassigned',
          accent: <AssigneeAvatar agentId={null} agents={agents} sessions={sessions} />,
        },
        ...agents.map((a) => ({
          key: String(a.id),
          label: a.name,
          accent: <AssigneeAvatar agentId={a.id} agents={agents} sessions={sessions} />,
        })),
      ]
    }
    return TASK_STATUSES.map((s) => ({
      key: s,
      label: intl.formatMessage(STATUS_MESSAGES[s]),
      accent: <StatusIcon status={s} />,
    }))
  }, [groupBy, teams, agents, sessions, intl])

  const groupKeyOf = useMemo(
    () => (t: TaskListItem) => {
      switch (groupBy) {
        case 'team':
          return t.teamId == null ? 'none' : String(t.teamId)
        case 'priority':
          return String(t.priority)
        case 'assignee':
          return t.assignedAgentId == null ? 'unassigned' : String(t.assignedAgentId)
        default:
          return t.status
      }
    },
    [groupBy],
  )

  const runTaskAction = async <T,>(action: () => Promise<T>, title = 'Task action failed'): Promise<T> => {
    try {
      return await action()
    } catch (error) {
      toastTaskError(error, title)
      throw error
    }
  }

  const onDrop = (taskId: number, key: string) => {
    const t = tasks.find((x) => x.id === taskId)
    if (!t) return
    if (groupBy === 'team') {
      const teamId = key === 'none' ? null : Number(key)
      if (t.teamId === teamId) return
      void update(taskId, { teamId }).catch((error) =>
        toastTaskError(error, 'Task update failed'),
      )
      return
    }
    if (groupBy === 'priority') {
      const priority = Number(key) as TaskPriority
      if (t.priority === priority) return
      void update(taskId, { priority }).catch((error) =>
        toastTaskError(error, 'Task update failed'),
      )
      return
    }
    if (groupBy === 'assignee') {
      const assignedAgentId = key === 'unassigned' ? null : Number(key)
      if (t.assignedAgentId === assignedAgentId) return
      void update(taskId, { assignedAgentId }).catch((error) =>
        toastTaskError(error, 'Task update failed'),
      )
      return
    }
    // status grouping
    const status = key as TaskStatus
    if (t.status === status || !isValidTaskTransition(t.status, status)) return
    if (status === 'in_progress' && t.status === 'todo' && t.assignedAgentId) {
      void dispatch(taskId, t.assignedAgentId).catch((error) =>
        toastTaskError(error, 'Dispatch failed'),
      )
    } else {
      void update(taskId, { status }).catch((error) =>
        toastTaskError(error, 'Task update failed'),
      )
    }
  }

  if (detail) {
    return (
      <TaskDetailView
        detail={detail}
        agents={agents}
        sessions={sessions}
        onClose={closeDetail}
        onOpenWorkspace={onOpenWorkspace}
      />
    )
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar — scrolls horizontally on phones so controls keep their size
          instead of getting crushed into vertical text. */}
      <div className="h-12 flex items-center gap-2 px-4 border-b border-border/40 shrink-0 bg-background overflow-x-auto [&>*]:shrink-0">
        <div className="flex items-center rounded-lg bg-muted/25 border border-border/40 p-0.5">
          <ToolbarToggle
            active={view === 'list'}
            onClick={() => setView('list')}
            icon={<ListIcon className="w-3.5 h-3.5" />}
            label={intl.formatMessage({ id: 'task.toolbar.list', defaultMessage: 'List' })}
          />
          <ToolbarToggle
            active={view === 'board'}
            onClick={() => setView('board')}
            icon={<LayoutGrid className="w-3.5 h-3.5" />}
            label={intl.formatMessage({ id: 'task.toolbar.board', defaultMessage: 'Board' })}
          />
          <ToolbarToggle
            active={view === 'teams'}
            onClick={() => setView('teams')}
            icon={<Users className="w-3.5 h-3.5" />}
            label={intl.formatMessage({ id: 'task.toolbar.teams', defaultMessage: 'Teams' })}
          />
        </div>

        {view !== 'teams' && <GroupBySelect value={groupBy} onChange={setGroupBy} />}

        {/* On phones the row scrolls, so drop the spacer that would push New Task
            off-screen; at md+ it right-aligns the filters as before. */}
        <div className="hidden md:block md:flex-1" />

        <FilterSelect
          value={fStatus}
          onChange={setFStatus}
          allLabel={intl.formatMessage({ id: 'task.toolbar.allStatus', defaultMessage: 'All status' })}
          options={TASK_STATUSES.map((s) => ({ value: s, label: intl.formatMessage(STATUS_MESSAGES[s]) }))}
        />
        <FilterSelect
          value={fPriority}
          onChange={setFPriority}
          allLabel={intl.formatMessage({ id: 'task.toolbar.allPriority', defaultMessage: 'All priority' })}
          options={TASK_PRIORITIES.map((p) => ({ value: String(p), label: intl.formatMessage(priorityMessage(p)) }))}
        />
        <FilterSelect
          value={fTeam}
          onChange={setFTeam}
          allLabel={intl.formatMessage({ id: 'task.toolbar.allTeams', defaultMessage: 'All teams' })}
          options={[
            { value: 'none', label: 'No team' },
            ...teams.map((tm) => ({ value: String(tm.id), label: tm.name })),
          ]}
        />
        <FilterSelect
          value={fAssignee}
          onChange={setFAssignee}
          allLabel={intl.formatMessage({ id: 'task.toolbar.allAssignees', defaultMessage: 'All assignees' })}
          options={[
            { value: 'unassigned', label: 'Unassigned' },
            ...agents.map((a) => ({ value: String(a.id), label: a.name })),
          ]}
        />

        {archivedCount > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              'h-8 gap-1.5 text-xs',
              showArchived
                ? 'bg-muted/50 text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setShowArchived((v) => !v)}
            title={showArchived ? 'Hide archived tasks' : 'Show archived tasks'}
          >
            <Archive className="w-3.5 h-3.5" />
            {showArchived
              ? intl.formatMessage({ id: 'task.toolbar.hideArchived', defaultMessage: 'Hide archived' })
              : intl.formatMessage({ id: 'task.toolbar.showArchived', defaultMessage: 'Archived · {count}' }, { count: archivedCount })}
          </Button>
        )}

        <Button
          size="sm"
          variant="secondary"
          className="h-8 gap-1.5"
          onClick={() => setShowNew(true)}
        >
          <Plus className="w-3.5 h-3.5" />
          {intl.formatMessage({ id: 'task.toolbar.newTask', defaultMessage: 'New Task' })}
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full gap-2 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : view === 'list' ? (
          <TaskListView
            tasks={filtered}
            agents={agents}
            sessions={sessions}
            groups={groups}
            groupKeyOf={groupKeyOf}
            onOpen={openDetail}
          />
        ) : view === 'board' ? (
          <TaskBoardView
            tasks={filtered}
            agents={agents}
            sessions={sessions}
            groups={groups}
            groupKeyOf={groupKeyOf}
            onOpen={openDetail}
            onDrop={onDrop}
          />
        ) : (
          <TaskTeamsView
            tasks={filtered}
            teams={teams}
            agents={agents}
            sessions={sessions}
            onOpen={openDetail}
            onCreateTeam={(name, color) =>
              runTaskAction(() => createTeam({ name, color }), 'Team update failed')
            }
            onUpdateTeam={(teamId, name, color) =>
              runTaskAction(() => updateTeam(teamId, { name, color }), 'Team update failed')
            }
            onDeleteTeam={(teamId) =>
              runTaskAction(() => deleteTeam(teamId), 'Team delete failed')
            }
          />
        )}
      </div>

      {showNew && (
        <NewTaskDialog
          agents={agents}
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false)
            void openDetail(id)
          }}
        />
      )}
    </div>
  )
}

function ToolbarToggle({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors',
        active ? 'bg-popover/90 shadow-card text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/45',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function GroupBySelect({ value, onChange }: { value: GroupBy; onChange: (v: GroupBy) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as GroupBy)}>
      <SelectTrigger className="h-8 w-auto gap-1.5 bg-popover/45 border-border/40 text-xs text-muted-foreground shadow-none">
        <span className="text-muted-foreground/50">Group:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="start"
        sideOffset={6}
        className="border border-border/40 bg-popover/95 backdrop-blur-sm shadow-float"
      >
        <SelectItem value="status">Status</SelectItem>
        <SelectItem value="priority">Priority</SelectItem>
        <SelectItem value="assignee">Assignee</SelectItem>
        <SelectItem value="team">Team</SelectItem>
      </SelectContent>
    </Select>
  )
}

function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
}: {
  value: string
  onChange: (v: string) => void
  allLabel: string
  options: { value: string; label: string }[]
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-auto gap-1.5 bg-popover/45 border-border/40 text-xs text-muted-foreground shadow-none">
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="start"
        sideOffset={6}
        className="border border-border/40 bg-popover/95 backdrop-blur-sm shadow-float"
      >
        <SelectItem value="all">{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
