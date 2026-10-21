import { ListTodo, Archive } from 'lucide-react'
import { FormattedMessage } from 'react-intl'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { PriorityIcon, LabelChip, AssigneeAvatar, TaskRef, relativeTime, type TaskGroup } from './task-meta'
import type { TaskListItem } from '@/types/task'
import { SpecCardBadge } from '@/components/spec/spec-shared'
import type { Agent, AgentSession } from '@/types/channel'

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
  sessions,
  onClick,
}: {
  task: TaskListItem
  agents: Agent[]
  sessions: AgentSession[]
  onClick: () => void
}) {
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
      <span className="flex-1 min-w-0 truncate text-sm text-foreground/90">{task.title}</span>
      {/* A spec at a gate is waiting on the reader — on the phone this list is the only board. */}
      <span className="shrink-0">
        <SpecCardBadge task={task} />
      </span>
      <div className="hidden md:flex items-center gap-1.5 shrink-0">
        {task.labels.slice(0, 3).map((l) => (
          <LabelChip key={l.id} label={l} />
        ))}
      </div>
      <span className="text-[11px] text-muted-foreground/40 tabular-nums w-9 text-right shrink-0">
        {relativeTime(task.updatedAt)}
      </span>
      <AssigneeAvatar agentId={task.assignedAgentId} agents={agents} sessions={sessions} projectId={task.projectId} />
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
