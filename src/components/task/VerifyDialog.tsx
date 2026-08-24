import { useState } from 'react'
import { useIntl, FormattedMessage } from 'react-intl'
import { Loader2, ShieldCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api } from '@/lib/api'
import { toastTaskError } from './task-error-toast'
import type { Agent } from '@/types/channel'

interface VerifyDialogProps {
  taskId: number
  agents: Agent[]
  /** The change's implementer — pre-selected against, so the default is independent. */
  implementerAgentId: number | null
  onClose: () => void
  onDispatched: () => void
}

/**
 * Pick the agent that verifies a finished change. Opt-in: the human can close this
 * and mark the change Done straight away — the sign-off then records that nothing
 * was verified, so skipping is cheap but never invisible.
 *
 * Defaults to an agent that is NOT the implementer, since the whole point is an
 * independent read of the diff. Choosing the implementer is allowed (a project may
 * only have one agent) but flagged.
 */
export function VerifyDialog({
  taskId,
  agents,
  implementerAgentId,
  onClose,
  onDispatched,
}: VerifyDialogProps) {
  const intl = useIntl()
  const independent = agents.find((a) => a.id !== implementerAgentId)
  const [agentId, setAgentId] = useState(String(independent?.id ?? agents[0]?.id ?? ''))
  const [starting, setStarting] = useState(false)

  const selfReview = Number(agentId) === implementerAgentId

  const confirm = async () => {
    if (!agentId || starting) return
    setStarting(true)
    try {
      const res = await api.taskVerify(taskId, Number(agentId))
      if (res.error) {
        toastTaskError(new Error(res.error), 'Could not start verification')
        return
      }
      onDispatched()
    } catch (error) {
      toastTaskError(error, 'Could not start verification')
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-[calc(100vw-2rem)] overflow-hidden sm:max-w-lg">
        <DialogHeader className="min-w-0">
          <DialogTitle className="text-base">
            <FormattedMessage id="task.verify.title" defaultMessage="Verify this change" />
          </DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-4 pt-2">
          <p className="text-xs leading-5 text-muted-foreground">
            <FormattedMessage
              id="task.verify.hint"
              defaultMessage="The verifier gets a throwaway worktree cut from this change branch, checks every acceptance criterion in the spec itself, and files its findings as the acceptance report you sign at Done. It cannot change code or move the task."
            />
          </p>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              <FormattedMessage id="task.verify.agent" defaultMessage="Verifier" />
            </span>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger className="h-8 w-44 gap-1.5 border-border/50 bg-muted/30 text-xs">
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
                    {a.id === implementerAgentId ? ' · implementer' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selfReview && (
            <div className="rounded-lg border border-status-warn/15 bg-status-warn/10 px-3 py-2 text-xs leading-5 text-status-warn">
              <FormattedMessage
                id="task.verify.selfReview"
                defaultMessage="This agent implemented the change. It will be reviewing its own work, which is much weaker than an independent check."
              />
            </div>
          )}
        </div>

        <div className="mt-2 flex min-w-0 justify-end gap-2 border-t border-border/40 pt-2">
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onClose}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5"
            disabled={!agentId || starting}
            onClick={() => void confirm()}
          >
            {starting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            {starting
              ? intl.formatMessage({ id: 'task.verify.starting', defaultMessage: 'Starting…' })
              : intl.formatMessage({ id: 'task.verify.start', defaultMessage: 'Run verifier' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
