import { FormattedMessage, useIntl } from 'react-intl'
import { Target, Pause, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
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

/** The goal in progress, above the composer: an Item (icon, objective, status and spend, actions). */
export function GoalBanner({ goal, onClear, onPause, onResume }: GoalBannerProps) {
  const intl = useIntl()
  const isActive = goal.status === 'active'
  const canResume = isResumableGoalStatus(goal.status)
  const canToggle = toggleGoalStatus(goal.status) !== null
  const toggleLabel = isActive
    ? intl.formatMessage({ id: 'editor.goal.pause', defaultMessage: 'Pause goal' })
    : intl.formatMessage({ id: 'editor.goal.resume', defaultMessage: 'Resume goal' })
  const clearLabel = intl.formatMessage({ id: 'editor.goal.clear', defaultMessage: 'Clear goal' })
  const spent = [
    typeof goal.timeUsedSeconds === 'number' && goal.timeUsedSeconds > 0 ? formatDuration(goal.timeUsedSeconds) : null,
    typeof goal.tokensUsed === 'number' && goal.tokensUsed > 0 ? `${goal.tokensUsed.toLocaleString()} tokens` : null,
  ].filter(Boolean)

  return (
    <Item variant="outline" size="xs" className="rounded-xl bg-background shadow-card">
      <ItemMedia variant="icon" className="text-muted-foreground">
        {/* No spinner: the status line says it is running, and the Working marker spins. */}
        <Target />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full min-w-0">
          <span className="truncate" title={goal.objective}>{goal.objective}</span>
        </ItemTitle>
        <ItemDescription className="truncate">
          {statusLabel(goal.status)}
          {spent.map((part) => ` · ${part}`)}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="gap-0.5">
        {canToggle && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={isActive ? onPause : onResume}
            disabled={!isActive && !canResume}
            aria-label={toggleLabel}
            title={toggleLabel}
          >
            {isActive ? <Pause /> : <Play />}
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClear} aria-label={clearLabel} title={clearLabel}>
          <Trash2 />
        </Button>
      </ItemActions>
    </Item>
  )
}
