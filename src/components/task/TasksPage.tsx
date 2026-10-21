import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Plus, List as ListIcon, LayoutGrid, Loader2, Archive } from 'lucide-react'
import { FormattedMessage, useIntl } from 'react-intl'
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
import { TaskListView } from './TaskListView'
import { TaskBoardView } from './TaskBoardView'
import { TaskDetailView } from './TaskDetailView'
import { NewTaskDialog } from './NewTaskDialog'
import { StatusIcon, PriorityIcon, AssigneeAvatar, TaskScopeContext, type TaskGroup } from './task-meta'
import { useProjectStore } from '@/stores/project-store'
import {
  TASK_STATUSES,
  TASK_PRIORITIES,
  isValidTaskTransition,
} from '@/types/task'
import { STATUS_MESSAGES, priorityMessage } from './task-i18n'
import { toastTaskError } from './task-error-toast'
import type { TaskListItem, TaskStatus, TaskPriority } from '@/types/task'
import type { SpecChatRef } from '@shared/spec'

interface TasksPageProps {
  /** Show one project's tasks, or null for every project's. The tasks themselves
   *  are loaded (and kept live) by the page around this one, for every project. */
  projectFilter: number | null
  onOpenWorkspace?: (workspaceId: number) => void
  /** Opens a conversation a task links to (a spec's agents and tickets). */
  onOpenChat?: (chat: SpecChatRef) => void
  /** A task captured from a channel message links back to it. */
  onOpenChannel?: (channelId: number, messageId: number | null) => void
  /** Deep-link target (e.g. from an inbox notification): open this task's detail
   *  once, after the initial load. Cleared via {@link onInitialTaskConsumed}. */
  initialTaskId?: number | null
  onInitialTaskConsumed?: () => void
  /** Pinned at the toolbar's end, outside the part that scrolls on phones (the channels button). */
  toolbarEnd?: ReactNode
  /** What it opens on. The board by default; the phone opens on the list, a column at a time being too narrow a view. */
  initialView?: ViewMode
  /** The toolbar's New Task button. The phone puts its own above the toolbar, which scrolls sideways. */
  showNewTask?: boolean
  /**
   * Grouping and filters from outside, with no toolbar of its own and always the
   * list: the phone keeps them in the native header's menu instead.
   */
  controls?: TaskViewControls
  /** With `controls`: clear a header floating over the list. */
  listTopOffset?: string
  /** With `controls`: clear a tab bar floating over the list. */
  listBottomOffset?: string
}

export type GroupBy = 'status' | 'priority' | 'assignee'
type ViewMode = 'list' | 'board'

/** The toolbar's state; `'all'` means that filter is off. */
export interface TaskViewControls {
  groupBy: GroupBy
  status: string
  priority: string
  assignee: string
  showArchived: boolean
}

export function TasksPage({ projectFilter, onOpenWorkspace, onOpenChat, onOpenChannel, initialTaskId, onInitialTaskConsumed, toolbarEnd, initialView = 'board', showNewTask = true, controls, listTopOffset, listBottomOffset }: TasksPageProps) {
  const intl = useIntl()
  const allTasks = useTaskStore((s) => s.tasks)
  const projects = useProjectStore((s) => s.projects)
  const projectsLoaded = useProjectStore((s) => s.projectsLoaded)
  const mixed = projectFilter == null
  const tasks = useMemo(() => {
    if (!mixed) return allTasks.filter((t) => t.projectId === projectFilter)
    // A removed project's tasks stay in the database with nowhere to go; leave them out.
    if (!projectsLoaded) return allTasks
    const live = new Set(projects.map((p) => p.id))
    return allTasks.filter((t) => live.has(t.projectId))
  }, [allTasks, mixed, projectFilter, projects, projectsLoaded])
  const detail = useTaskStore((s) => s.detail)
  const loading = useTaskStore((s) => s.loading)
  const openDetail = useTaskStore((s) => s.openDetail)
  const closeDetail = useTaskStore((s) => s.closeDetail)
  const update = useTaskStore((s) => s.update)
  const dispatch = useTaskStore((s) => s.dispatch)
  const agents = useChannelStore((s) => s.agents)
  const sessions = useChannelStore((s) => s.sessions)
  // The board first (on a desktop): where everything stands at a glance is what the page is opened for.
  const [ownView, setView] = useState<ViewMode>(initialView)
  const [ownGroupBy, setGroupBy] = useState<GroupBy>('status')
  const [showNew, setShowNew] = useState(false)
  const [ownStatus, setFStatus] = useState<string>('all')
  const [ownAssignee, setFAssignee] = useState<string>('all')
  const [ownPriority, setFPriority] = useState<string>('all')
  const [ownShowArchived, setShowArchived] = useState(false)
  // Controlled (the phone): the header's menu holds these, and it is always the list.
  const view: ViewMode = controls ? 'list' : ownView
  const groupBy = controls?.groupBy ?? ownGroupBy
  const fStatus = controls?.status ?? ownStatus
  const fAssignee = controls?.assignee ?? ownAssignee
  const fPriority = controls?.priority ?? ownPriority
  const showArchived = controls?.showArchived ?? ownShowArchived

  // Deep-link: open the requested task's detail once. load() keeps an open detail
  // when it re-enters the same scope, and never touches it on completion.
  useEffect(() => {
    if (initialTaskId == null) return
    void openDetail(initialTaskId)
    onInitialTaskConsumed?.()
  }, [initialTaskId, openDetail, onInitialTaskConsumed])

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
      return true
    })
  }, [tasks, fStatus, fAssignee, fPriority, showArchived])

  // Grouping axis for List sections / Board columns.
  const groups: TaskGroup[] = useMemo(() => {
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
  }, [groupBy, agents, sessions, intl])

  const groupKeyOf = useMemo(
    () => (t: TaskListItem) => {
      switch (groupBy) {
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

  const onDrop = (taskId: number, key: string) => {
    const t = tasks.find((x) => x.id === taskId)
    if (!t) return
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
      <TaskScopeContext.Provider value={{ mixed }}>
        <TaskDetailView
          detail={detail}
          agents={agents}
          sessions={sessions}
          onClose={closeDetail}
          onOpenWorkspace={onOpenWorkspace}
          onOpenChat={onOpenChat}
          onOpenChannel={onOpenChannel}
        />
      </TaskScopeContext.Provider>
    )
  }

  return (
    <TaskScopeContext.Provider value={{ mixed }}>
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar — scrolls horizontally on phones so controls keep their size
          instead of getting crushed into vertical text. Not there when controlled. */}
      {!controls && (
      <div className="h-12 flex items-center border-b border-border/40 shrink-0 bg-background">
        <div className="h-full min-w-0 flex-1 flex items-center gap-2 px-4 overflow-x-auto [&>*]:shrink-0">
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
          </div>

          <GroupBySelect value={groupBy} onChange={setGroupBy} />

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

          {showNewTask && (
            <Button
              size="sm"
              variant="secondary"
              className="h-8 gap-1.5"
              onClick={() => setShowNew(true)}
            >
              <Plus className="w-3.5 h-3.5" />
              {intl.formatMessage({ id: 'task.toolbar.newTask', defaultMessage: 'New Task' })}
            </Button>
          )}
        </div>
        {toolbarEnd && <div className="flex h-full shrink-0 items-center gap-1 border-l border-border/40 px-2">{toolbarEnd}</div>}
      </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full gap-2 text-muted-foreground text-sm" style={{ paddingTop: listTopOffset }}>
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
            topOffset={listTopOffset}
            bottomOffset={listBottomOffset}
          />
        ) : (
          <TaskBoardView
            tasks={filtered}
            agents={agents}
            sessions={sessions}
            groups={groups}
            groupKeyOf={groupKeyOf}
            onOpen={openDetail}
            onDrop={onDrop}
          />
        )}
      </div>

      {showNew && (
        <NewTaskDialog
          agents={agents}
          defaultProjectId={projectFilter}
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false)
            void openDetail(id)
          }}
        />
      )}
    </div>
    </TaskScopeContext.Provider>
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
        active ? 'bg-popover/90 shadow-card text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-row-hover',
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
        <span className="text-muted-foreground/50">
          <FormattedMessage id="task.groupBy.label" defaultMessage="Group:" />
        </span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="start"
        sideOffset={6}
        className="border border-border/40 bg-popover/95 backdrop-blur-sm shadow-float"
      >
        <SelectItem value="status"><FormattedMessage id="task.groupBy.status" defaultMessage="Status" /></SelectItem>
        <SelectItem value="priority"><FormattedMessage id="task.groupBy.priority" defaultMessage="Priority" /></SelectItem>
        <SelectItem value="assignee"><FormattedMessage id="task.groupBy.assignee" defaultMessage="Assignee" /></SelectItem>
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
