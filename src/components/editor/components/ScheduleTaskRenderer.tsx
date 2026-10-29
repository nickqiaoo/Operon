import { CalendarClock, ChevronRightIcon } from 'lucide-react'
import { FormattedMessage } from 'react-intl'
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
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

/**
 * A `schedule_create` / `schedule_update` call, as a Trace line that links out:
 * it opens the Schedule page on that task.
 */
export function ScheduleTaskRenderer({ toolPart }: { toolPart: ToolPartLike }) {
  const task = scheduledTask(toolPart)
  const action = scheduleAction(toolPart)
  if (!task || !action) return null

  const details = [task.when, task.provider_id].filter(Boolean).join(' · ')

  return (
    <Trace>
      <button type="button" onClick={() => openSchedulePage(task.id)}>
        <TraceLine>
          <TraceIcon><CalendarClock /></TraceIcon>
          <TraceTitle>
            {action === 'created' ? (
              <FormattedMessage id="editor.schedule.createdLine" defaultMessage="Scheduled {name}" values={{ name: task.name }} />
            ) : (
              <FormattedMessage id="editor.schedule.updatedLine" defaultMessage="Updated schedule {name}" values={{ name: task.name }} />
            )}
          </TraceTitle>
          {details && <TraceDescription className="min-w-0 shrink truncate">{details}</TraceDescription>}
          {!task.enabled && (
            <TraceDescription>
              <FormattedMessage id="editor.schedule.paused" defaultMessage="paused" />
            </TraceDescription>
          )}
          <TraceIcon><ChevronRightIcon /></TraceIcon>
        </TraceLine>
      </button>
    </Trace>
  )
}
