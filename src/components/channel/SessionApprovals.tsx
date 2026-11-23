import { FormattedMessage } from 'react-intl'
import { ShieldAlert } from 'lucide-react'
import { InboxApprovals } from '@/components/inbox/InboxApprovals'
import type { Agent, WaitingSession } from '@/types/channel'

/**
 * What a channel or thread session is waiting on — a tool approval or a
 * question — answered where the session lives. Nobody watches an agent's own
 * chat, so without this the session sat blocked on a prompt only its
 * workspace tab showed. The approve / deny / answer controls are the inbox's.
 */
export function SessionApprovals({ waiting, agents }: { waiting: WaitingSession[]; agents: Agent[] }) {
  if (waiting.length === 0) return null
  return (
    <div className="space-y-2">
      {waiting.map((w) => {
        const name = agents.find((a) => a.id === w.agentId)?.name ?? `Agent ${w.agentId}`
        return (
          <div
            key={w.chatId}
            className="space-y-1.5 rounded-xl border border-status-warn/15 bg-status-warn/10 p-2.5"
          >
            <div className="flex items-center gap-1.5 px-0.5 text-xs text-status-warn">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                <FormattedMessage
                  id="channel.approval.waiting"
                  defaultMessage="{name} is waiting for your approval"
                  values={{ name }}
                />
              </span>
            </div>
            <InboxApprovals chatId={w.chatId} version={approvalsVersion(w.approvalIds)} />
          </div>
        )
      })}
    </div>
  )
}

/** A number that changes whenever the set of pending requests does — the approvals query's cache key. */
function approvalsVersion(ids: string[]): number {
  let h = 0
  for (const ch of ids.join('|')) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
  return h
}
