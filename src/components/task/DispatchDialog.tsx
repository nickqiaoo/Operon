import { useState } from 'react'
import { useIntl, FormattedMessage } from 'react-intl'
import { Loader2, Zap } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTaskStore } from '@/stores/task-store'
import { toastTaskError } from './task-error-toast'
import type { Agent } from '@/types/channel'
import type { PreparedSubtask } from '@/types/task'
import { splitPlanTaskText } from '@shared/taskboard/plan-task'

interface DispatchDialogProps {
  taskId: number
  /** Subtasks from POST /prepare — the dialog only opens when there's ≥1. */
  subtasks: PreparedSubtask[]
  agents: Agent[]
  /** The parent's current assignee — the default agent for every row. */
  defaultAgentId: number | null
  onClose: () => void
  onDispatched: () => void
}

/**
 * Per-subtask agent assignment before dispatching an SDD feature. The plan is
 * already approved + decomposed (POST /prepare) by the time this opens; here the
 * human picks which agent runs each subtask, then dispatches them all. Defaults
 * to the parent's assignee, so the common case is just "Dispatch all".
 */
export function DispatchDialog({
  taskId,
  subtasks,
  agents,
  defaultAgentId,
  onClose,
  onDispatched,
}: DispatchDialogProps) {
  const intl = useIntl()
  const dispatch = useTaskStore((s) => s.dispatch)
  const fallback = String(defaultAgentId ?? agents[0]?.id ?? '')
  const [defaultAgent, setDefaultAgent] = useState(fallback)
  const [rowAgents, setRowAgents] = useState<Record<number, string>>(() =>
    Object.fromEntries(subtasks.map((s) => [s.id, String(s.assignedAgentId ?? fallback)])),
  )
  const [dispatching, setDispatching] = useState(false)

  // Changing the default applies it to every row (rows can then be overridden).
  const setAllTo = (agentId: string) => {
    setDefaultAgent(agentId)
    setRowAgents(Object.fromEntries(subtasks.map((s) => [s.id, agentId])))
  }

  const confirm = async () => {
    if (!defaultAgent || dispatching) return
    setDispatching(true)
    try {
      const map: Record<number, number> = {}
      for (const s of subtasks) map[s.id] = Number(rowAgents[s.id] ?? defaultAgent)
      await dispatch(taskId, Number(defaultAgent), map)
      onDispatched()
    } catch (error) {
      toastTaskError(error, 'Dispatch failed')
    } finally {
      setDispatching(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-[calc(100vw-2rem)] overflow-hidden sm:max-w-2xl">
        <DialogHeader className="min-w-0">
          <DialogTitle className="text-base">
            <FormattedMessage id="task.dispatch.title" defaultMessage="Dispatch subtasks" />
          </DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-3 pt-2">
          <p className="text-xs text-muted-foreground">
            <FormattedMessage
              id="task.dispatch.hint"
              defaultMessage="Assign an agent to each subtask, then dispatch them all. Each runs on its own branch cut from this change."
            />
          </p>

          <div className="max-h-[min(24rem,50vh)] min-w-0 space-y-2 overflow-x-hidden overflow-y-auto pr-1">
            {subtasks.map((s) => (
              <div
                key={s.id}
                className="flex min-w-0 flex-col items-stretch gap-2 rounded-lg border border-border/40 bg-background/40 p-2.5 sm:flex-row sm:items-start sm:gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div
                    className="line-clamp-2 break-words text-sm leading-snug"
                    title={s.title}
                  >
                    {splitPlanTaskText(s.title).title}
                  </div>
                  <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {s.planAnchor ?? `#${s.number}`}
                    {s.claimedAcs?.length ? ` · ${s.claimedAcs.join(', ')}` : ''}
                  </div>
                </div>
                <Select
                  value={rowAgents[s.id] ?? defaultAgent}
                  onValueChange={(v) => setRowAgents((m) => ({ ...m, [s.id]: v }))}
                >
                  <SelectTrigger className="h-8 w-full shrink-0 gap-1.5 border-border/50 bg-muted/30 text-xs sm:w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="end"
                    sideOffset={6}
                    className="border-none bg-popover/95 backdrop-blur-sm shadow-float"
                  >
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <FormattedMessage id="task.dispatch.setAll" defaultMessage="Set all to" />
            <Select value={defaultAgent} onValueChange={setAllTo}>
              <SelectTrigger className="h-7 w-36 gap-1.5 bg-muted/30 border-border/50 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                position="popper"
                align="start"
                sideOffset={6}
                className="border-none bg-popover/95 backdrop-blur-sm shadow-float"
              >
                {agents.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="min-w-0">
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onClose}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5"
            disabled={!defaultAgent || dispatching}
            onClick={() => void confirm()}
          >
            {dispatching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )}
            {dispatching
              ? intl.formatMessage({ id: 'task.dispatch.dispatching', defaultMessage: 'Dispatching…' })
              : intl.formatMessage({ id: 'task.dispatch.dispatchAll', defaultMessage: 'Dispatch all' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
