import { TaskAssigneeAvatar, TaskExecutionIndicator } from './TaskExecutionIndicator'
import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import { Archive, Ban, CornerDownRight } from 'lucide-react'
import { FormattedMessage, useIntl } from 'react-intl'
import { cn } from '@/lib/utils'
import { useTaskStore } from '@/stores/task-store'
import { PriorityIcon, LabelChip, TaskRef, type TaskGroup } from './task-meta'
import { SpecCardBadge } from '@/components/spec/spec-shared'
import type { TaskListItem } from '@/types/task'
import type { Agent, AgentSession } from '@/types/channel'

interface TaskBoardViewProps {
  tasks: TaskListItem[]
  agents: Agent[]
  sessions: AgentSession[]
  groups: TaskGroup[]
  groupKeyOf: (task: TaskListItem) => string
  onOpen: (taskId: number) => void
  /** Card dropped onto a different group's column (status: dispatch/move; team: reassign). */
  onDrop: (taskId: number, groupKey: string) => void
}

export function TaskBoardView({
  tasks,
  agents,
  sessions,
  groups,
  groupKeyOf,
  onOpen,
  onDrop,
}: TaskBoardViewProps) {
  const [activeId, setActiveId] = useState<number | null>(null)
  // Touch drags only after a press-and-hold: a plain swipe has to scroll the columns
  // (and the cards), which a pointer sensor would grab as a drag after 5px.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  )
  const activeTask = activeId != null ? tasks.find((t) => t.id === activeId) ?? null : null

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null)
    const taskId = Number(e.active.id)
    const overKey = e.over?.id != null ? String(e.over.id) : undefined
    if (!overKey) return
    const task = tasks.find((t) => t.id === taskId)
    if (!task || groupKeyOf(task) === overKey) return
    onDrop(taskId, overKey)
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e: DragStartEvent) => setActiveId(Number(e.active.id))}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      {/* Phone: a column nearly fills the screen and a swipe settles on the next one. */}
      <div className="h-full flex gap-3 overflow-x-auto p-4 bg-background snap-x snap-mandatory scroll-px-4 md:snap-none">
        {groups.map((group) => (
          <Column
            key={group.key}
            group={group}
            tasks={tasks.filter((t) => groupKeyOf(t) === group.key)}
            agents={agents}
            sessions={sessions}
            onOpen={onOpen}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeTask ? <CardBody task={activeTask} agents={agents} sessions={sessions} dragging /> : null}
      </DragOverlay>
    </DndContext>
  )
}

interface ColumnProps {
  group: TaskGroup
  tasks: TaskListItem[]
  agents: Agent[]
  sessions: AgentSession[]
  onOpen: (taskId: number) => void
}

function Column({ group, tasks, agents, sessions, onOpen }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: group.key })
  return (
    <div className="flex flex-col w-[85vw] md:w-72 snap-start shrink-0 rounded-xl border border-border/50 bg-muted/20 p-2 dark:border-border/35 dark:bg-muted/15">
      <div className="flex items-center gap-2 px-1.5 pb-2 text-xs">
        {group.accent}
        <span className="font-semibold text-foreground/80">{group.label}</span>
        <span className="text-muted-foreground/50 tabular-nums">{tasks.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 min-h-[120px] rounded-lg border border-transparent space-y-2 overflow-y-auto transition-colors',
          isOver && 'border-border/50 bg-muted/30',
        )}
      >
        {tasks.length === 0 ? (
          <div className="flex h-20 items-center justify-center rounded-lg border border-dashed border-border/40 text-xs text-muted-foreground/45 dark:border-border/35">
            <FormattedMessage id="task.board.emptyColumn" defaultMessage="No tasks" />
          </div>
        ) : (
          tasks.map((task) => (
            <DraggableCard
              key={task.id}
              task={task}
              agents={agents}
              sessions={sessions}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface DraggableCardProps {
  task: TaskListItem
  agents: Agent[]
  sessions: AgentSession[]
  onOpen: (taskId: number) => void
}

function DraggableCard({ task, agents, sessions, onOpen }: DraggableCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id })
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onOpen(task.id)}
      // The press-and-hold that starts a touch drag must not select text or open the callout.
      className={cn('cursor-grab touch-manipulation select-none [-webkit-touch-callout:none] active:cursor-grabbing', isDragging && 'opacity-30')}
    >
      <CardBody task={task} agents={agents} sessions={sessions} />
    </div>
  )
}

interface CardBodyProps {
  task: TaskListItem
  agents: Agent[]
  sessions: AgentSession[]
  dragging?: boolean
}

function CardBody({ task, agents, dragging }: CardBodyProps) {
  const intl = useIntl()
  const archived = task.archivedAt != null
  const tasks = useTaskStore((s) => s.tasks)
  const parent = task.parentTaskId != null ? tasks.find((t) => t.id === task.parentTaskId) : undefined
  const openBlockers = (task.blockedBy ?? [])
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is TaskListItem => t != null && t.status !== 'done' && t.status !== 'cancelled')
  // Spelled out for the title tooltip and screen readers; the card shows only the numbers.
  const subtaskOf =
    parent && intl.formatMessage({ id: 'task.card.subtaskOf', defaultMessage: 'Sub-task of #{number}' }, { number: parent.number })
  const blockedBy = intl.formatMessage(
    { id: 'task.card.blockedBy', defaultMessage: 'Blocked by {tasks}' },
    { tasks: openBlockers.map((b) => `#${b.number}`).join(', ') },
  )
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 bg-popover/95 p-2.5 space-y-2 shadow-card transition-[border-color,background-color,box-shadow] dark:border-border/35 dark:bg-popover/80',
        !dragging && 'hover:border-border hover:bg-popover dark:hover:border-border/50',
        dragging && 'shadow-float rotate-2 cursor-grabbing',
        archived && 'opacity-55',
      )}
    >
      <div className="flex items-center gap-2">
        <PriorityIcon priority={task.priority} />
        <TaskRef projectId={task.projectId} number={task.number} className="text-[11px] text-muted-foreground/50" />
        <TaskAssigneeAvatar task={task} agents={agents} />
        {parent && (
          <span
            className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground/50 tabular-nums"
            title={subtaskOf}
          >
            <CornerDownRight className="w-3 h-3" aria-hidden />
            <span aria-hidden>#{parent.number}</span>
            <span className="sr-only">{subtaskOf}</span>
          </span>
        )}
        {openBlockers.length > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-status-warn tabular-nums" title={blockedBy}>
            <Ban className="w-3 h-3" aria-hidden />
            <span aria-hidden>{openBlockers.map((b) => `#${b.number}`).join(' ')}</span>
            <span className="sr-only">{blockedBy}</span>
          </span>
        )}
        {archived && <Archive className="w-3 h-3 text-muted-foreground/50" />}
        <span className="ml-auto">
          <SpecCardBadge task={task} />
        </span>
      </div>
      {/* anywhere: a path or file name in the title has no spaces to break at, and would run out of the card. */}
      <div className="text-sm text-foreground/90 leading-snug line-clamp-3 [overflow-wrap:anywhere]">{task.title}</div>
      <TaskExecutionIndicator task={task} className="flex w-full" />
      {task.labels.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {task.labels.slice(0, 2).map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}
    </div>
  )
}
