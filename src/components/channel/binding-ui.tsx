import { FormattedMessage, useIntl } from 'react-intl'
import { Hash, MessageSquare, Send, GitBranch, ListChecks, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { scopeLabel, agentStatusLabel } from './channel-i18n'
import type { AgentBinding, AgentSessionStatus, BindingScopeKind, BindingStatus } from '@/types/channel'

/**
 * Shared UI for the binding (per-channel / per-task runtime instance) layer.
 *
 * An agent is one identity; each channel/task it runs in is a distinct binding
 * with its own session + status. These primitives render that instance layer
 * consistently across the Manage Agents dialog and the channel sidebar, so the
 * UI never collapses N instances into one arbitrary row.
 */

const SCOPE_ICON: Record<BindingScopeKind, typeof MessageSquare> = {
  app: Hash,
  slack: MessageSquare,
  telegram: Send,
  linear: GitBranch,
  task: ListChecks,
}

/** Anything with a status — both AgentSession and AgentBinding satisfy this. */
type HasStatus = { status: AgentSessionStatus | BindingStatus }

/** Count instances that are live (active or idle). */
export function countLive(items: HasStatus[]): number {
  return items.filter((b) => b.status === 'active' || b.status === 'idle').length
}

export function StatusDot({
  status,
  className,
}: {
  status: AgentSessionStatus | BindingStatus
  className?: string
}) {
  const intl = useIntl()
  return (
    <span
      title={agentStatusLabel(intl, status)}
      className={cn(
        'w-2 h-2 rounded-full shrink-0',
        status === 'active' && 'bg-blue-500 animate-pulse',
        status === 'idle' && 'bg-green-500',
        (status === 'offline' || status === 'completed') && 'bg-muted-foreground/30',
        className,
      )}
    />
  )
}

export function BindingCountBadge({
  count,
  total,
}: {
  count: number
  total: number
}) {
  const intl = useIntl()
  if (total === 0) {
    return (
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/40 shrink-0">
        <FormattedMessage id="channel.binding.unbound" defaultMessage="unbound" />
      </span>
    )
  }
  // Deliberately status-neutral: an agent's real status lives on each binding
  // row (its own session), not here — this is only a count of how many sessions
  // are live, never a single aggregate status colour. Offline bindings are
  // hidden from the lists, so callers pass live-only counts (count === total).
  return (
    <span
      className="inline-flex items-center px-1.5 h-[18px] rounded-full text-[10px] font-medium shrink-0 bg-muted/60 text-muted-foreground/70"
      title={intl.formatMessage(
        { id: 'channel.binding.liveCount', defaultMessage: '{count} of {total} bindings live' },
        { count, total },
      )}
    >
      {count === total ? count : `${count}/${total}`}
    </span>
  )
}

/** One binding = one channel/task the agent runs in, with its own status + reset. */
export function BindingRow({
  binding,
  resetting,
  onReset,
}: {
  binding: AgentBinding
  resetting: boolean
  onReset: () => void
}) {
  const intl = useIntl()
  const Icon = SCOPE_ICON[binding.scopeKind] ?? Hash
  const status: AgentSessionStatus =
    binding.status === 'active' ? 'active' : binding.status === 'idle' ? 'idle' : 'offline'
  const displayName = binding.scopeDisplayName || binding.scopeKey
  return (
    <div className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/30 transition-colors group">
      <Icon className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/50 shrink-0">
          {scopeLabel(intl, binding.scopeKind)}
        </span>
        <span className="text-xs text-foreground/80 truncate font-mono">{displayName}</span>
      </div>
      <StatusDot status={status} className="shrink-0" />
      <button
        type="button"
        onClick={onReset}
        disabled={resetting || binding.status === 'offline'}
        className={cn(
          'p-1 rounded transition-colors shrink-0',
          'text-muted-foreground hover:text-destructive hover:bg-destructive/10',
          'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground',
        )}
        title={
          binding.status === 'offline'
            ? intl.formatMessage({ id: 'channel.binding.alreadyOffline', defaultMessage: 'Already offline' })
            : intl.formatMessage({ id: 'channel.binding.resetBinding', defaultMessage: 'Reset this binding' })
        }
      >
        <RotateCcw className={cn('w-3.5 h-3.5', resetting && 'animate-spin')} />
      </button>
    </div>
  )
}
