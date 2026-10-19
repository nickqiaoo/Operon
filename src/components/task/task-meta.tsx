import { createContext, useContext, type ReactNode } from 'react'
import {
  Circle,
  CircleDot,
  CheckCircle2,
  XCircle,
  Minus,
  SignalLow,
  SignalMedium,
  SignalHigh,
  AlertTriangle,
  CircleDashed,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/icons/AgentAvatar'
import { useProjectStore } from '@/stores/project-store'
import type { Agent, AgentSession } from '@/types/channel'
import type { TaskStatus, TaskPriority, TaskLabel } from '@/types/task'

/** A grouping column/section for List & Board (by status, team, …). */
export interface TaskGroup {
  key: string
  label: string
  accent?: ReactNode
}

/* ── Status ── */

const STATUS_ICON: Record<TaskStatus, { Icon: typeof Circle; className: string }> = {
  todo: { Icon: Circle, className: 'text-muted-foreground/60' },
  in_progress: { Icon: CircleDot, className: 'text-status-warn' },
  in_review: { Icon: CircleDot, className: 'text-violet-500' },
  done: { Icon: CheckCircle2, className: 'text-status-ok' },
  cancelled: { Icon: XCircle, className: 'text-muted-foreground/40' },
}

export function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const { Icon, className: color } = STATUS_ICON[status]
  return <Icon className={cn('w-3.5 h-3.5 shrink-0', color, className)} />
}

/* ── Priority ── */

const PRIORITY_ICON: Record<TaskPriority, { Icon: typeof Minus; className: string }> = {
  0: { Icon: Minus, className: 'text-muted-foreground/40' },
  1: { Icon: SignalLow, className: 'text-muted-foreground/70' },
  2: { Icon: SignalMedium, className: 'text-status-info' },
  3: { Icon: SignalHigh, className: 'text-status-warn' },
  4: { Icon: AlertTriangle, className: 'text-status-error' },
}

export function PriorityIcon({
  priority,
  className,
}: {
  priority: TaskPriority
  className?: string
}) {
  const { Icon, className: color } = PRIORITY_ICON[priority]
  return <Icon className={cn('w-3.5 h-3.5 shrink-0', color, className)} />
}

/* ── Label chip ── */

export function LabelChip({ label }: { label: TaskLabel }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-muted/20 px-1.5 py-0.5 text-[10px] text-muted-foreground">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
      {label.name}
    </span>
  )
}

/* ── Task reference ── */

/**
 * Whether the board in view mixes projects. Task numbers restart at #1 in every
 * project, so a mixed board has to say whose #12 it is.
 */
export const TaskScopeContext = createContext<{ mixed: boolean }>({ mixed: false })

export function useProjectName(projectId: number): string | null {
  return useProjectStore((s) => s.projects.find((p) => p.id === projectId)?.name ?? null)
}

/** `#12`, or `operon #12` on a board that mixes projects. */
export function TaskRef({ projectId, number, className }: { projectId: number; number: number; className?: string }) {
  const { mixed } = useContext(TaskScopeContext)
  const projectName = useProjectName(projectId)
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1 tabular-nums', className)}>
      {mixed && projectName && <span className="truncate">{projectName}</span>}
      <span className="shrink-0">#{number}</span>
    </span>
  )
}

/* ── Assignee ── */

const STATUS_RANK: Record<AgentSession['status'], number> = { active: 2, idle: 1, offline: 0 }

/**
 * An agent has a session per project it works in. On one project's board that
 * project's session speaks for it; across projects, the liveliest one does.
 */
function agentStatus(sessions: AgentSession[], agentId: number, projectId?: number): AgentSession['status'] {
  let best: AgentSession['status'] = 'offline'
  for (const s of sessions) {
    if (s.agentId !== agentId || (projectId != null && s.projectId !== projectId)) continue
    if (STATUS_RANK[s.status] > STATUS_RANK[best]) best = s.status
  }
  return best
}

export function AssigneeAvatar({
  agentId,
  agents,
  sessions,
  projectId,
  size = 'sm',
}: {
  agentId: number | null
  agents: Agent[]
  sessions: AgentSession[]
  /** The task's project, so its status comes from the session that works on it. */
  projectId?: number
  size?: 'sm' | 'md'
}) {
  const agent = agentId != null ? agents.find((a) => a.id === agentId) ?? null : null
  if (!agent) {
    return (
      <CircleDashed
        className={cn('text-muted-foreground/40', size === 'sm' ? 'w-5 h-5' : 'w-6 h-6')}
      />
    )
  }
  const status = agentStatus(sessions, agent.id, projectId)
  return (
    <span className="relative inline-flex shrink-0" title={`${agent.name} · ${status}`}>
      <AgentAvatar provider={agent.provider} size={size} />
      <span
        className={cn(
          'absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-background',
          status === 'active' && 'bg-status-info animate-pulse',
          status === 'idle' && 'bg-accent-green',
          status === 'offline' && 'bg-muted-foreground/30',
        )}
      />
    </span>
  )
}

/* ── Relative time ── */

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  const mo = Math.floor(d / 30)
  return `${mo}mo`
}
