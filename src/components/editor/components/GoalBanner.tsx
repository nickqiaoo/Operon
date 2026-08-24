import { FormattedMessage, useIntl } from 'react-intl'
import { Target, Pause, Play, Trash2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { type CodexGoal, isResumableGoalStatus, toggleGoalStatus } from '@/types/goal'

interface GoalBannerProps {
  goal: CodexGoal
  onClear: () => void
  onPause: () => void
  onResume: () => void
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function statusLabel(status: string) {
  switch (status) {
    case 'active':
      return <FormattedMessage id="editor.goal.status.active" defaultMessage="Active goal" />
    case 'paused':
      return <FormattedMessage id="editor.goal.status.paused" defaultMessage="Goal paused" />
    case 'blocked':
      return <FormattedMessage id="editor.goal.status.blocked" defaultMessage="Goal blocked" />
    case 'usageLimited':
      return <FormattedMessage id="editor.goal.status.usageLimited" defaultMessage="Goal paused (usage limit)" />
    case 'budgetLimited':
      return <FormattedMessage id="editor.goal.status.budgetLimited" defaultMessage="Goal stopped (budget)" />
    default:
      return <FormattedMessage id="editor.goal.status.generic" defaultMessage="Goal" />
  }
}

export function GoalBanner({ goal, onClear, onPause, onResume }: GoalBannerProps) {
  const intl = useIntl()
  const isActive = goal.status === 'active'
  const canResume = isResumableGoalStatus(goal.status)
  const canToggle = toggleGoalStatus(goal.status) !== null

  const iconBtn =
    'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm',
        'shadow-card',
      )}
    >
      {isActive ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Target className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="shrink-0 text-muted-foreground">{statusLabel(goal.status)}</span>
      <span className="min-w-0 flex-1 truncate font-medium" title={goal.objective}>
        {goal.objective}
      </span>

      {typeof goal.timeUsedSeconds === 'number' && goal.timeUsedSeconds > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground">· {formatDuration(goal.timeUsedSeconds)}</span>
      )}
      {typeof goal.tokensUsed === 'number' && goal.tokensUsed > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground">· {goal.tokensUsed.toLocaleString()} tokens</span>
      )}

      <div className="ml-1 flex shrink-0 items-center gap-0.5">
        {canToggle && (
          <button
            type="button"
            className={iconBtn}
            onClick={isActive ? onPause : onResume}
            disabled={!isActive && !canResume}
            aria-label={
              isActive
                ? intl.formatMessage({ id: 'editor.goal.pause', defaultMessage: 'Pause goal' })
                : intl.formatMessage({ id: 'editor.goal.resume', defaultMessage: 'Resume goal' })
            }
            title={
              isActive
                ? intl.formatMessage({ id: 'editor.goal.pause', defaultMessage: 'Pause goal' })
                : intl.formatMessage({ id: 'editor.goal.resume', defaultMessage: 'Resume goal' })
            }
          >
            {isActive ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </button>
        )}
        <button
          type="button"
          className={iconBtn}
          onClick={onClear}
          aria-label={intl.formatMessage({ id: 'editor.goal.clear', defaultMessage: 'Clear goal' })}
          title={intl.formatMessage({ id: 'editor.goal.clear', defaultMessage: 'Clear goal' })}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
