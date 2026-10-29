import { Check, ChevronDown, Loader2, Pause, Play, Target, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { type CodexGoal, isResumableGoalStatus } from '@/types/goal'

interface GoalBannerProps {
  goal: CodexGoal
  pending?: boolean
  isGenerating?: boolean
  onClear: () => void
  onPause: () => void
  onResume: () => void
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function statusLabel(status: string, isGenerating: boolean): string {
  switch (status) {
    case 'active': return isGenerating ? 'Working' : 'Ready'
    case 'paused': return 'Paused'
    case 'blocked': return 'Blocked'
    case 'usageLimited': return 'Usage limit reached'
    case 'budgetLimited': return 'Budget reached'
    case 'complete': return 'Complete'
    default: return 'Goal'
  }
}

export function GoalBanner({ goal, pending = false, isGenerating = false, onClear, onPause, onResume }: GoalBannerProps) {
  const isActive = goal.status === 'active'
  const isPursuing = isActive && isGenerating
  const canResume = isResumableGoalStatus(goal.status)
  const status = statusLabel(goal.status, isGenerating)
  const spent = [
    typeof goal.tokensUsed === 'number' ? `${goal.tokensUsed.toLocaleString('en-US')} tokens` : null,
    goal.timeUsedSeconds ? formatDuration(goal.timeUsedSeconds) : null,
  ].filter(Boolean).join(' · ')

  return (
    <div data-testid="goal-banner" className="mb-1.5 flex min-w-0 items-center gap-2 rounded-lg bg-muted/35 px-2.5 py-1 text-xs">
      {goal.status === 'complete'
        ? <Check aria-hidden="true" className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        : <Target aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" aria-label="View goal details" className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1.5 text-left text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="truncate">{goal.objective}</span>
            <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-80 max-w-[calc(100vw-2rem)] space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">Goal</span>
            <span className="text-xs text-muted-foreground">{status}</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-foreground/85">{goal.objective}</p>
          {spent && <p className="text-xs tabular-nums text-muted-foreground">{spent}</p>}
          {goal.tokenBudget != null && <p className="text-xs text-muted-foreground">Budget: {goal.tokenBudget.toLocaleString('en-US')} tokens</p>}
          {goal.status === 'blocked' && <p className="text-xs text-muted-foreground">Review the conversation for what is needed before resuming.</p>}
          {goal.status === 'usageLimited' && <p className="text-xs text-muted-foreground">Resume when your usage limit resets.</p>}
        </PopoverContent>
      </Popover>
      <span role="status" className={cn('shrink-0 text-[11px] text-muted-foreground', isActive && isGenerating && 'text-tint')}>{status}</span>
      <div className="flex shrink-0 items-center gap-0.5">
        {(isActive || canResume) && (
          <Button type="button" variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" disabled={pending || (!isActive && isGenerating)} onClick={isPursuing ? onPause : onResume} aria-label={isPursuing ? 'Pause goal' : 'Resume goal'} title={isPursuing ? 'Pause goal' : 'Resume goal'}>
            {pending ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> : isPursuing ? <Pause aria-hidden="true" className="size-3.5" /> : <Play aria-hidden="true" className="size-3.5" />}
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" disabled={pending} onClick={onClear} aria-label="Clear goal" title="Clear goal">
          <X aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
