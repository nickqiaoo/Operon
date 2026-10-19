import { CalendarClock, ExternalLink } from 'lucide-react'
import { FormattedMessage } from 'react-intl'
import { cn } from '@/lib/utils'
import { openSchedulePage } from '@/lib/open-settings'
import { resultText, toolNameOf } from './TaskCreatedRenderer'
import type { ToolPartLike } from './toolName'

/** What the schedule MCP returns for a created or updated task (server/src/routes/schedule-mcp.ts). */
interface ScheduleTaskRef {
  id: number
  name: string
  enabled: boolean
  when?: string
  provider_id?: string
}

/**
 * Which call this is. The bare name is compared by suffix because clients prefix it
 * differently: `mcp__schedule__schedule_create`, OpenCode's `schedule_schedule_create`.
 */
function scheduleAction(toolPart: ToolPartLike): 'created' | 'updated' | null {
  const name = toolNameOf(toolPart)
  if (name.endsWith('schedule_create')) return 'created'
  if (name.endsWith('schedule_update')) return 'updated'
  return null
}

function scheduledTask(toolPart: ToolPartLike): ScheduleTaskRef | null {
  if (!scheduleAction(toolPart)) return null
  try {
    const task = (JSON.parse(resultText(toolPart)) as { task?: ScheduleTaskRef }).task
    return task && typeof task.id === 'number' && typeof task.name === 'string' ? task : null
  } catch {
    // Still streaming, or the call failed with a plain-text error.
    return null
  }
}

/**
 * True once a schedule call actually created or changed a task. Both the renderer and
 * `isCompactEligible` ask this, so a call only leaves the collapsed work group when there
 * is a card to draw.
 */
export function isScheduleTaskResult(toolPart: ToolPartLike): boolean {
  return scheduledTask(toolPart) !== null
}

/** Card for a `schedule_create` / `schedule_update` call; opens the Schedule page on that task. */
export function ScheduleTaskRenderer({ toolPart }: { toolPart: ToolPartLike }) {
  const task = scheduledTask(toolPart)
  const action = scheduleAction(toolPart)
  if (!task || !action) return null

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => openSchedulePage(task.id)}
        className={cn(
          'group flex w-full items-center gap-3 rounded-xl border border-border/50 bg-background/60 px-3 py-2.5 text-left',
          'shadow-card transition-colors hover:bg-row-hover hover:border-border',
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-muted/40">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {action === 'created' ? (
              <FormattedMessage id="editor.schedule.created" defaultMessage="Scheduled task created" />
            ) : (
              <FormattedMessage id="editor.schedule.updated" defaultMessage="Scheduled task updated" />
            )}
            {!task.enabled && (
              <span className="normal-case tracking-normal">
                · <FormattedMessage id="editor.schedule.paused" defaultMessage="paused" />
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-sm font-medium text-foreground">{task.name}</span>
          {(task.when || task.provider_id) && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {[task.when, task.provider_id].filter(Boolean).join(' · ')}
            </span>
          )}
        </span>
        <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>
    </div>
  )
}
