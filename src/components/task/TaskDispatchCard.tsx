import { useState } from 'react'
import { AlertCircle, ChevronRightIcon, ClipboardList, Loader2, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
import { useAssignableAgents, useDispatchTask, useTask } from '@/lib/task-queries'
import { requestOpenTask } from '@/lib/task-navigation'

/**
 * A board task created from a conversation: opens the task, and while it is still
 * todo hands it to an agent without another round of chat.
 */
export function TaskDispatchCard({ projectId, taskId, taskNumber, title }: {
  projectId: number
  taskId: number
  taskNumber: number
  title: string
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { data: task } = useTask(taskId)
  const { data: agents, isPending: agentsLoading, isError: agentsFailed } = useAssignableAgents(menuOpen)
  const dispatch = useDispatchTask(taskId)

  const canDispatch = task?.status === 'todo' && task.specStage == null
  const assignee = task && task.status !== 'todo' ? task.assignedAgent?.name : undefined

  return (
    <Trace>
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" className="min-w-0 flex-1" onClick={() => requestOpenTask({ projectId, taskId })}>
          <TraceLine>
            <TraceIcon><ClipboardList /></TraceIcon>
            <TraceTitle>Created task {task?.title ?? title}</TraceTitle>
            <TraceDescription className="font-mono">
              #{taskNumber}{assignee ? ` · @${assignee}` : ''}
            </TraceDescription>
            <TraceIcon><ChevronRightIcon /></TraceIcon>
          </TraceLine>
        </button>
        {canDispatch && (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary" className="h-7 shrink-0 gap-1.5 text-xs" disabled={dispatch.isPending}>
                {dispatch.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Dispatch
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              {agentsLoading && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
              {agentsFailed && <DropdownMenuItem disabled>Could not load agents</DropdownMenuItem>}
              {agents?.length === 0 && <DropdownMenuItem disabled>No agents yet. Add one in Channels.</DropdownMenuItem>}
              {agents?.map((agent) => (
                <DropdownMenuItem key={agent.id} onSelect={() => dispatch.mutate(agent.id)} className="justify-between gap-4">
                  <span className="truncate">@{agent.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{agent.provider}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {dispatch.isError && (
        <div className="flex items-center gap-1.5 text-xs text-status-error">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {dispatch.error instanceof Error ? dispatch.error.message : 'Could not dispatch the task.'}
        </div>
      )}
    </Trace>
  )
}
