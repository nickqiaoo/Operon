import { AlertCircle, Loader2 } from 'lucide-react'
import type { SpecChatRef, SpecView } from '@shared/spec'
import { AgentAvatar } from '@/components/icons/AgentAvatar'
import { listSpecSessions } from '@/components/spec/session-groups'
import { useSpecView } from '@/components/spec/spec-shared'
import { fileCitationsToText } from '@/lib/file-citation'

export interface MobileSpecChatTarget {
  chatId: number
  workspaceId?: number
  title: string
  subAgent: boolean
  providerId?: string | null
}

/** All Spec conversations, including agents and tickets in other workspaces. */
export function MobileSpecChatsList({ specId, onOpenChat, view, includeDiscussion = true, selectedChatId }: {
  specId: number
  onOpenChat: (target: MobileSpecChatTarget) => void
  view?: SpecView
  includeDiscussion?: boolean
  selectedChatId?: number
}) {
  const result = useSpecView(specId, undefined, view == null)
  const spec = view ?? result.spec
  const error = result.error
  if (!spec) return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground" role="status">
      {error ? <AlertCircle className="size-4" /> : <Loader2 className="size-4 animate-spin" />}
      <span>{error ? 'Could not load conversations. Retrying…' : 'Loading conversations…'}</span>
    </div>
  )
  const sessions = listSpecSessions(spec).filter((entry) => includeDiscussion || entry.chat.chatId !== spec.sourceChat?.chatId)
  if (sessions.length === 0) return (
    <p className="px-4 py-10 text-center text-sm text-muted-foreground">No conversations yet.</p>
  )
  const openChat = (chat: SpecChatRef) => onOpenChat({
    chatId: chat.chatId,
    workspaceId: chat.workspaceId ?? undefined,
    title: chat.title,
    subAgent: chat.subAgent,
    providerId: chat.providerId,
  })
  return sessions.map(({ chat, label, state, phase }, index) => (
    <div key={chat.chatId} className={phase && phase !== sessions[index - 1]?.phase ? 'mt-5' : undefined}>
    {phase && phase !== sessions[index - 1]?.phase && <h3 className="px-3 pb-2 text-base font-bold text-foreground/90">{phase}</h3>}
    <button
      type="button"
      aria-current={chat.chatId === selectedChatId ? 'page' : undefined}
      onClick={() => openChat(chat)}
      className={`flex w-full items-center gap-3 rounded-lg py-3 text-left hover:bg-row-hover aria-[current=page]:bg-row-selected ${phase ? 'pl-6 pr-3' : 'px-3'}`}
    >
      <AgentAvatar provider={chat.providerId ?? undefined} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground/85">{chat.chatId === spec.sourceChat?.chatId ? 'Discussion' : fileCitationsToText(label)}</span>
      </span>
      {state === 'running' && <Loader2 className="size-4 shrink-0 animate-spin text-status-info" aria-label="Running" />}
      {state === 'error' && <AlertCircle className="size-4 shrink-0 text-status-error" aria-label="Error" />}
    </button>
    </div>
  ))
}
