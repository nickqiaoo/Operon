import { AlertCircle, Loader2 } from 'lucide-react'
import type { SpecChatRef } from '@shared/spec'
import { AgentAvatar } from '@/components/icons/AgentAvatar'
import { listSpecSessions } from '@/components/spec/session-groups'
import { useSpecView } from '@/components/spec/spec-shared'
import { fileCitationsToText } from '@/lib/file-citation'

export interface MobileSpecChatTarget {
  chatId: number
  workspaceId?: number
  title: string
  subAgent: boolean
}

/** All Spec conversations, including agents and tickets in other workspaces. */
export function MobileSpecChatsList({ specId, onOpenChat }: {
  specId: number
  onOpenChat: (target: MobileSpecChatTarget) => void
}) {
  const { spec, error } = useSpecView(specId)
  if (!spec) return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground" role="status">
      {error ? <AlertCircle className="size-4" /> : <Loader2 className="size-4 animate-spin" />}
      <span>{error ? 'Could not load conversations. Retrying…' : 'Loading conversations…'}</span>
    </div>
  )
  const sessions = listSpecSessions(spec)
  if (sessions.length === 0) return (
    <p className="px-4 py-10 text-center text-sm text-muted-foreground">No conversations yet.</p>
  )
  const openChat = (chat: SpecChatRef) => onOpenChat({
    chatId: chat.chatId,
    workspaceId: chat.workspaceId ?? undefined,
    title: chat.title,
    subAgent: chat.subAgent,
  })
  return sessions.map(({ chat, label, state, phase }) => (
    <button
      key={chat.chatId}
      type="button"
      onClick={() => openChat(chat)}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-row-hover"
    >
      <AgentAvatar provider={chat.providerId ?? undefined} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base text-foreground/85">{fileCitationsToText(label)}</span>
        {phase && <span className="text-xs text-muted-foreground/60">{phase}</span>}
      </span>
      {state === 'running' && <Loader2 className="size-4 shrink-0 animate-spin text-status-info" aria-label="Running" />}
      {state === 'error' && <AlertCircle className="size-4 shrink-0 text-status-error" aria-label="Error" />}
    </button>
  ))
}
