import { lazy, Suspense } from 'react'
import { resultText, toolNameOf } from './TaskCreatedRenderer'
import type { ToolPartLike } from './toolName'

const ScheduleTaskApp = lazy(() => import('./ScheduleTaskApp'))

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
 * A completed create/update opens the task's MCP App inline in the conversation.
 */
export function ScheduleTaskRenderer({ toolPart }: { toolPart: ToolPartLike }) {
  const task = scheduledTask(toolPart)
  if (!task) return null

  return (
    <Suspense fallback={<p className="py-3 text-xs text-muted-foreground">Loading scheduled task…</p>}>
      <ScheduleTaskApp key={task.id} taskId={task.id} />
    </Suspense>
  )
}
