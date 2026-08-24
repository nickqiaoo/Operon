import { ListTodo, Archive } from 'lucide-react'
import { FormattedMessage } from 'react-intl'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { PriorityIcon, LabelChip, AssigneeAvatar, relativeTime, type TaskGroup } from './task-meta'
import type { TaskListItem } from '@/types/task'
import type { Agent, AgentSession } from '@/types/channel'

interface TaskListViewProps {
  tasks: TaskListItem[]
  agents: Agent[]
  sessions: AgentSession[]
  groups: TaskGroup[]
  groupKeyOf: (task: TaskListItem) => string
  onOpen: (taskId: number) => void
}

export function TaskListView({ tasks, agents, sessions, groups, groupKeyOf, onOpen }: TaskListViewProps) {
  if (tasks.length === 0) return <EmptyTasks />

  return (
    <ScrollArea className="h-full">
      <div className="py-2">
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
        'w-full flex items-center gap-3 px-4 md:px-5 py-2 text-left border-b border-border/40 hover:bg-muted/20 transition-colors',
        archived && 'opacity-55',
      )}
    >
      <PriorityIcon priority={task.priority} />
      <span className="text-xs text-muted-foreground/50 tabular-nums w-12 shrink-0">#{task.number}</span>
      {archived && <Archive className="w-3 h-3 text-muted-foreground/50 shrink-0" />}
      <span className="flex-1 min-w-0 truncate text-sm text-foreground/90">{task.title}</span>
      <div className="hidden md:flex items-center gap-1.5 shrink-0">
        {task.labels.slice(0, 3).map((l) => (
          <LabelChip key={l.id} label={l} />
        ))}
      </div>
      <span className="text-[11px] text-muted-foreground/40 tabular-nums w-9 text-right shrink-0">
        {relativeTime(task.updatedAt)}
      </span>
      <AssigneeAvatar agentId={task.assignedAgentId} agents={agents} sessions={sessions} />
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
