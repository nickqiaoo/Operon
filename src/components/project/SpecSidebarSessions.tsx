import { fileCitationsToText } from '@/lib/file-citation'
import { Fragment, useId, useState } from 'react'
import { AlertCircle, Loader2, MessageSquareText } from 'lucide-react'
import { ProviderIcon } from '@/components/icons/ProviderLabel'
import { listSpecSessions } from '@/components/spec/session-groups'
import { useSpecView } from '@/components/spec/spec-shared'

const PREVIEW_COUNT = 5

export function SpecSidebarSessions({ taskId, onOpenChat }: {
  taskId: number
  onOpenChat: (target: { chatId: number; workspaceId?: number; title?: string }) => void
}) {
  const { spec, error } = useSpecView(taskId)
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  if (!spec) return (
    <div className="flex items-center gap-2 py-2 pl-11 pr-3 text-xs text-muted-foreground" role="status">
      {error ? <AlertCircle className="size-3.5 shrink-0" /> : <Loader2 className="size-3.5 shrink-0 animate-spin" />}
      <span>{error ? 'Could not load sessions' : 'Loading sessions…'}</span>
    </div>
  )
  const rows = listSpecSessions(spec)
  const visible = expanded ? rows : rows.slice(0, PREVIEW_COUNT)
  return (
    <div>
      <div id={listId}>
        {visible.map(({ chat, label, state, phase }, index) => (
          <Fragment key={chat.chatId}>
            {expanded && phase && phase !== visible[index - 1]?.phase && (
              <div className="pt-2 pb-0.5 pl-11 pr-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{phase}</div>
            )}
            <button
              type="button"
              title={fileCitationsToText(label)}
              onClick={() => onOpenChat({ chatId: chat.chatId, workspaceId: chat.workspaceId ?? undefined, title: chat.title })}
              className="flex w-full min-w-0 items-center gap-2 rounded-lg py-1 [@media(pointer:coarse)]:py-2 pl-11 pr-3 text-left text-[13px] font-medium text-foreground/70 transition-colors hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {chat.providerId ? <ProviderIcon id={chat.providerId} size={14} /> : <MessageSquareText className="size-3.5 text-muted-foreground" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{fileCitationsToText(label)}</span>
              {state === 'running' && <Loader2 className="size-3 shrink-0 animate-spin text-status-info" />}
              {state === 'error' && <AlertCircle className="size-3 shrink-0 text-status-error" />}
            </button>
          </Fragment>
        ))}
      </div>
      {rows.length > PREVIEW_COUNT && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center justify-start whitespace-nowrap rounded-lg py-1 [@media(pointer:coarse)]:py-2 pl-[calc(2.75rem+3px)] pr-3 text-left text-[13px] text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
