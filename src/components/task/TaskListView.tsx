import { TaskAssigneeAvatar, TaskExecutionIndicator } from './TaskExecutionIndicator'
import { ListTodo, Archive } from 'lucide-react'
import { FormattedMessage, useIntl } from 'react-intl'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { PriorityIcon, LabelChip, TaskRef, type TaskGroup } from './task-meta'
import type { TaskListItem } from '@/types/task'
import { SpecCardBadge, specCardBadgeShown } from '@/components/spec/spec-shared'
import type { Agent, AgentSession } from '@/types/channel'
import { formatRelativeTime } from '@/lib/format'

interface TaskListViewProps {
  tasks: TaskListItem[]
  agents: Agent[]
  sessions: AgentSession[]
  groups: TaskGroup[]
  groupKeyOf: (task: TaskListItem) => string
  onOpen: (taskId: number) => void
  /** Clear a header floating over the list (the phone's native bar); the rows scroll under it. */
  topOffset?: string
  /** Likewise the phone's floating tab bar, at the bottom. */
  bottomOffset?: string
}

export function TaskListView({ tasks, agents, sessions, groups, groupKeyOf, onOpen, topOffset, bottomOffset }: TaskListViewProps) {
  if (tasks.length === 0) return <div className="h-full" style={{ paddingTop: topOffset }}><EmptyTasks /></div>

  return (
    // The viewport's inner wrapper is `display: table`, which grows to the longest title and
    // defeats the rows' truncate (the date and assignee went off-screen); block keeps it to the width.
    <ScrollArea className="h-full" viewportClassName="[&>div]:!block">
      <div
        className="py-2"
        style={{
          paddingTop: topOffset ? `calc(${topOffset} + 0.5rem)` : undefined,
          paddingBottom: bottomOffset ? `calc(${bottomOffset} + 0.5rem)` : undefined,
        }}
      >
        {groups.map((group) => {
          const inGroup = tasks.filter((t) => groupKeyOf(t) === group.key)
          if (inGroup.length === 0) return null
          return (
            <div key={group.key} className="mb-1">
              <div className="flex items-center gap-2 px-4 md:px-5 py-1.5 text-xs">
                {group.accent}
                <span className="font-semibold text-foreground/80">{group.label}</span>
                <span className="text-muted-foreground/50 tabular-nums">{inGroup.length}</span>
              </div>
              <div>
                {inGroup.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    agents={agents}
                    sessions={sessions}
                    onClick={() => onOpen(task.id)}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function TaskRow({
  task,
  agents,
  onClick,
}: {
  task: TaskListItem
  agents: Agent[]
  sessions: AgentSession[]
  onClick: () => void
}) {
  const intl = useIntl()
  const archived = task.archivedAt != null
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-4 md:px-5 py-2 text-left border-b border-border/40 hover:bg-row-hover transition-colors',
        archived && 'opacity-55',
      )}
    >
      <PriorityIcon priority={task.priority} />
      <TaskRef projectId={task.projectId} number={task.number} className="text-xs text-muted-foreground/50 min-w-12 max-w-32 shrink-0" />
      {archived && <Archive className="w-3 h-3 text-muted-foreground/50 shrink-0" />}
      <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <span className="w-full truncate text-sm text-foreground/90">{task.title}</span>
        {/* On the phone the spec badge sits under the title: as a column of its
            own it squeezed the title to a few letters. A spec task's badge also
            carries its running state, so it never shows the chip as well. */}
        <span className="flex w-full min-w-0 items-center gap-1.5 empty:hidden md:contents">
          {!specCardBadgeShown(task) && <TaskExecutionIndicator task={task} className="max-w-full overflow-hidden" />}
          <SpecCardBadge task={task} className="shrink-0 md:hidden" />
        </span>
      </span>
      {/* Badges hug the timestamp: a fixed column of its own left the spec
          badge floating mid-row whenever the row had no labels. A spec at a
          gate is waiting on the reader — on the phone this list is the only board. */}
      <div className="flex shrink-0 items-center justify-end gap-1.5 overflow-hidden md:w-60">
        <SpecCardBadge task={task} className="hidden md:inline-flex" />
        <span className="hidden md:contents">
          {task.labels.slice(0, 3).map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </span>
      </div>
      <span className="text-[11px] text-muted-foreground/40 tabular-nums w-12 text-right shrink-0 whitespace-nowrap">
        {formatRelativeTime(intl, task.updatedAt, { compact: true })}
      </span>
      <span className="flex w-6 shrink-0 items-center justify-center">
        <TaskAssigneeAvatar task={task} agents={agents} />
      </span>
    </button>
  )
}

function EmptyTasks() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground/50 gap-2">
      <ListTodo className="w-8 h-8 opacity-40" />
      <p className="text-sm"><FormattedMessage id="task.list.empty.title" defaultMessage="No tasks yet" /></p>
      <p className="text-xs"><FormattedMessage id="task.list.empty.hint" defaultMessage='Click "New Task" to create one' /></p>
    </div>
  )
}
