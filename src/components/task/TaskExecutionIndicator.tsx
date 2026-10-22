import { FormattedMessage } from 'react-intl'
import { AgentAvatar } from '@/components/icons/AgentAvatar'
import { ProviderLabel } from '@/components/icons/ProviderLabel'
import { cn } from '@/lib/utils'
import type { TaskListItem } from '@/types/task'
import type { Agent } from '@/types/channel'

export function isTaskRunning(task: Pick<TaskListItem, 'status' | 'archivedAt' | 'executionStatus'>): boolean {
  return task.executionStatus === 'active' && task.archivedAt == null && task.status !== 'done' && task.status !== 'cancelled'
}

/** Driven by the task's binding, never another task using the same agent. */
export function TaskExecutionIndicator({ task, className }: { task: TaskListItem; className?: string }) {
  if (!isTaskRunning(task)) return null
  const agent = task.executionAgent
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2 rounded-md bg-status-info/8 px-2 py-1 text-[11px] text-status-info', className)}>
      <span className="flex h-3 shrink-0 items-center gap-0.5" aria-hidden>
        {[8, 12, 6].map((height, i) => (
          <span
            key={i}
            className="w-0.5 rounded-full bg-current motion-safe:animate-pulse"
            style={{ height, animationDelay: `${i * 180}ms`, animationDuration: '1s' }}
          />
        ))}
      </span>
      {agent && <ProviderLabel id={agent.provider} size={12} />}
      <span className="shrink-0"><FormattedMessage id="task.execution.running" defaultMessage="Running" /></span>
    </span>
  )
}

/** Includes hidden Spec agents; the dot describes this task's own execution. */
export function TaskAssigneeAvatar({ task, agents }: { task: TaskListItem; agents: Agent[] }) {
  const agent = (task.assignedAgent?.id === task.assignedAgentId ? task.assignedAgent : null) ?? agents.find((a) => a.id === task.assignedAgentId)
  if (!agent) return <span className="size-5 shrink-0 rounded-full border border-dashed border-muted-foreground/40" title="Unassigned" />
  const running = isTaskRunning(task) && task.executionAgent?.id === agent.id
  return (
    <span className="relative inline-flex shrink-0" title={agent.name}>
      <AgentAvatar provider={agent.provider} size="sm" />
      {running && <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-status-info ring-2 ring-background motion-safe:animate-pulse" />}
    </span>
  )
}
