import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { Check, ChevronRight, CircleAlert, Copy, MessageSquare, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/format'
import type { ChannelMessage, ChannelThread, Agent } from '@/types/channel'
import { UNREAD_CAP } from '@/types/channel'
import type { TaskListItem } from '@/types/task'
import { StatusIcon, TaskRef } from '@/components/task/task-meta'
import { ChannelImages } from './ChannelImages'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { AgentAvatar } from '@/components/icons/AgentAvatar'
import type { MarkdownMention } from '@/lib/markdown-mentions'
import { agentNameColor } from './agent-name-color'

/** How long the copy button stays on its confirmed state. Matches the chat composer's. */
const COPIED_RESET_MS = 1500

interface ChannelMessageItemProps {
  message: ChannelMessage
  agents: Agent[]
  /** true when the previous message has the same sender — hides avatar/name, tightens spacing */
  grouped?: boolean
  onReply: (messageId: number) => void
  /** Tasks captured from this message; each opens on the board. */
  tasks?: TaskListItem[]
  onOpenTask?: (taskId: number) => void
  /** Flashed after a jump here from a task. */
  highlighted?: boolean
  /** The thread under this message, when there is one. */
  thread?: ChannelThread
  /** Agent replies in the thread you have not read yet. */
  threadUnread?: number
  /** For your own message that failed to send (`localState: 'failed'`). */
  onRetrySend?: (localId: number) => void
  onDiscardSend?: (localId: number) => void
}

export const ChannelMessageItem = memo(function ChannelMessageItem({
  message,
  agents,
  grouped,
  onReply,
  tasks,
  onOpenTask,
  highlighted,
  thread,
  threadUnread = 0,
  onRetrySend,
  onDiscardSend,
}: ChannelMessageItemProps) {
  const intl = useIntl()
  const isAgent = message.senderType === 'agent'
  const isSystem = message.senderType === 'system'
  const mentions = useAgentMentions(agents)

  const agent = isAgent && message.senderId
    ? agents.find((a) => a.id === message.senderId)
    : null

  // Only flips to the check once the write actually resolves — a clipboard write
  // can be rejected (denied permission, non-secure context), and confirming a
  // copy that never happened is worse than showing nothing.
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (copyTimer.current != null) clearTimeout(copyTimer.current)
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content)
    } catch {
      return
    }
    setCopied(true)
    if (copyTimer.current != null) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS)
  }, [message.content])

  if (isSystem) {
    return <SystemNotice content={message.content} />
  }

  const isUser = !isAgent
  const hasText = message.content.trim() !== ''
  const hasImages = (message.attachments?.length ?? 0) > 0
  const senderName = isAgent
    ? (agent?.name ?? message.senderName)
    : intl.formatMessage({ id: 'channel.message.you', defaultMessage: 'You' })

  const actions = (
    <div className={cn(
      'absolute z-10 flex items-center gap-0.5 rounded-lg border border-border/60 bg-popover p-0.5 shadow-float dark:border-border/35',
      // Keyboard focus keeps it open; a mouse click must not — focus-within
      // left the bar pinned after clicking Copy, so two bars showed at once.
      'opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto',
      // Yours: beside the bubble, in the empty space on its left — anchored
      // over the bubble it covered short messages ("hi") and ran past the
      // column edge. Agents': on the name row's empty right end, not poking up
      // into the previous message; grouped lines have no name row, so it sits
      // above as before.
      isUser ? 'right-full top-0 mr-1.5' : cn('right-2', grouped ? '-top-3.5' : 'top-1.5'),
    )}>
      <ActionButton icon={<MessageSquare className="size-3.5" />} label={intl.formatMessage({ id: 'channel.message.reply', defaultMessage: 'Reply' })} onClick={() => onReply(message.id)} />
      <ActionButton
        icon={copied
          ? <Check className="size-3.5 text-status-ok" />
          : <Copy className="size-3.5" />}
        label={copied
          ? intl.formatMessage({ id: 'common.copied', defaultMessage: 'Copied' })
          : intl.formatMessage({ id: 'common.copy', defaultMessage: 'Copy' })}
        onClick={() => void handleCopy()}
      />
    </div>
  )

  const footer = (
    <>
      {(message.replyCount > 0 || thread) && (
        <ThreadSummary
          count={message.replyCount}
          lastReplyAt={message.lastReplyAt}
          thread={thread}
          unread={threadUnread}
          agents={agents}
          onClick={() => onReply(message.id)}
        />
      )}
      {tasks && tasks.length > 0 && (
        <div className={cn('mt-1.5 flex flex-wrap gap-1', isUser && 'justify-end')}>
          {tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              onClick={() => onOpenTask?.(task.id)}
              disabled={!onOpenTask}
              className="flex max-w-72 items-center gap-1.5 rounded-lg border border-border/50 bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground disabled:pointer-events-none dark:border-border/35"
            >
              <StatusIcon status={task.status} />
              <TaskRef projectId={task.projectId} number={task.number} className="shrink-0 text-muted-foreground/70" />
              <span className="truncate text-foreground/85">{task.title}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )

  // Your own messages: a right-hand bubble, like the main chat. Agents' replies
  // are flat text under an avatar + name row — in a channel several agents
  // talk, so who said it has to be readable at a glance, but a bordered card
  // around every reply made the transcript a stack of boxes.
  if (isUser) {
    return (
      <div
        data-message-id={message.id}
        className={cn(
          'group relative flex flex-col items-end rounded-xl px-2 transition-colors duration-500 md:px-3',
          grouped ? 'pt-1' : 'pt-4',
          highlighted && 'bg-row-selected',
        )}
      >
        {!grouped && (
          <span className="mb-1 pr-1 text-[11px] leading-none text-muted-foreground/60 tabular-nums">
            {formatTime(message.createdAt)}
          </span>
        )}
        <div className={cn(
          'relative flex max-w-[85%] flex-col items-end transition-opacity md:max-w-[75%]',
          message.localState === 'sending' && 'opacity-60',
        )}>
          {/* Not saved yet: nothing to reply under or act on. */}
          {message.localState == null && actions}
          {hasText && (
            <div className="rounded-xl bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground phone:text-base">
              <MarkdownRenderer content={message.content} mentions={mentions} />
            </div>
          )}
          {hasImages && (
            <ChannelImages attachments={message.attachments!} align="end" className={hasText ? 'mt-1.5' : undefined} />
          )}
        </div>
        {message.localState === 'failed' && (
          <SendFailed onRetry={() => onRetrySend?.(message.id)} onDiscard={() => onDiscardSend?.(message.id)} />
        )}
        <div className="flex max-w-[85%] flex-col items-end md:max-w-[75%]">{footer}</div>
      </div>
    )
  }

  return (
    <div
      data-message-id={message.id}
      className={cn(
        'group relative flex gap-3 rounded-xl px-2 transition-colors duration-500 md:px-3',
        grouped ? 'pt-1' : 'pt-4',
        highlighted && 'bg-row-selected',
      )}
    >
      {actions}
      <div className="w-7 flex-none">
        {!grouped && <AgentAvatar provider={agent?.provider} size="sm" className="mt-0.5 size-7" />}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="mb-1 flex items-baseline gap-2 leading-none">
            <span className={cn('text-[13px] font-semibold', agentNameColor(agent?.id))}>
              {senderName}
            </span>
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {formatTime(message.createdAt)}
            </span>
          </div>
        )}
        {hasText && (
          <div className="text-sm leading-relaxed text-foreground phone:text-base">
            <MarkdownRenderer content={message.content} mentions={mentions} />
          </div>
        )}
        {hasImages && <ChannelImages attachments={message.attachments!} className={hasText ? 'mt-1.5' : undefined} />}
        {footer}
      </div>
    </div>
  )
})

/** Under your message when the server never took it: say so, and offer to send it again or drop it. */
export function SendFailed({ onRetry, onDiscard, className }: { onRetry: () => void; onDiscard: () => void; className?: string }) {
  return (
    <div role="alert" className={cn('mt-1 flex items-center gap-1.5 pr-1 text-xs', className)}>
      <CircleAlert className="size-3.5 shrink-0 text-status-error" />
      <span className="text-status-error">
        <FormattedMessage id="channel.composer.sendFailed" defaultMessage="Message could not be sent" />
      </span>
      <button type="button" onClick={onRetry} className="rounded-md px-1 font-medium text-foreground transition-colors hover:bg-accent-hover">
        <FormattedMessage id="common.retry" defaultMessage="Retry" />
      </button>
      <button type="button" onClick={onDiscard} className="rounded-md px-1 text-muted-foreground transition-colors hover:bg-accent-hover hover:text-foreground">
        <FormattedMessage id="common.delete" defaultMessage="Delete" />
      </button>
    </div>
  )
}

/** `@name` highlights for every agent, each in its name color (same as the sender row). */
export function useAgentMentions(agents: Agent[]): MarkdownMention[] {
  return useMemo(
    () => agents.map((a) => ({ name: a.name, className: agentNameColor(a.id) })),
    [agents],
  )
}

/** A one-line event ("Reset Claude…") between messages: a quiet rule, not a pill. */
function SystemNotice({ content }: { content: string }) {
  return (
    <div className="flex items-center gap-3 px-3 pt-4 text-xs text-muted-foreground/70">
      <span className="h-px flex-1 bg-border/50 dark:bg-border/35" />
      <span className="max-w-[80%] truncate">{content}</span>
      <span className="h-px flex-1 bg-border/50 dark:bg-border/35" />
    </div>
  )
}

/**
 * Thread entry under a message. In a channel the work on a message happens in
 * its thread, so this is the one thing under a message that must not be
 * missed: a small bordered row with the count in link color, who owns the
 * thread, what state it is in, and the owner's one-line summary.
 */
function ThreadSummary({ count, lastReplyAt, thread, unread, agents, onClick }: {
  count: number
  unread: number
  lastReplyAt: number | null | undefined
  thread: ChannelThread | undefined
  agents: Agent[]
  onClick: () => void
}) {
  const owner = thread?.ownerAgentId != null ? agents.find((a) => a.id === thread.ownerAgentId) : undefined
  const running = (thread?.activeAgentIds.length ?? 0) > 0
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/thread mt-1.5 flex max-w-full flex-col items-start gap-0.5 rounded-lg border border-border/50 bg-background px-2.5 py-1 text-left text-xs transition-colors hover:bg-row-hover dark:border-border/35"
    >
      <span className="flex max-w-full items-center gap-2">
        <MessageSquare className="size-3.5 shrink-0 text-link" />
        <span className="shrink-0 font-medium text-link">
          <FormattedMessage
            id="channel.message.replyCount"
            defaultMessage="{count, plural, one {# reply} other {# replies}}"
            values={{ count }}
          />
        </span>
        {unread > 0 && (
          <span className="flex shrink-0 items-center gap-1 font-semibold text-foreground">
            <span className="size-1.5 rounded-full bg-tint" />
            <FormattedMessage
              id="channel.message.newReplies"
              defaultMessage="{count} new"
              values={{ count: unread >= UNREAD_CAP ? '99+' : unread }}
            />
          </span>
        )}
        {owner && (
          <span className="flex min-w-0 shrink items-center gap-1">
            <AgentAvatar provider={owner.provider} size="sm" className="size-4" />
            <span className={cn('truncate font-medium', agentNameColor(owner.id))}>{owner.name}</span>
          </span>
        )}
        {thread && <ThreadStatusLabel status={thread.status} running={running} needsApproval={thread.waiting.length > 0} />}
        {lastReplyAt != null && !running && (
          <span className="truncate text-muted-foreground/70 tabular-nums">
            <FormattedMessage
              id="channel.message.lastReply"
              defaultMessage="Last reply {time}"
              values={{ time: formatReplyTime(lastReplyAt) }}
            />
          </span>
        )}
        <ChevronRight className="-mr-1 size-3.5 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover/thread:opacity-100" />
      </span>
      {thread?.summary && (
        <span className="max-w-full truncate pl-5.5 text-muted-foreground">{thread.summary}</span>
      )}
    </button>
  )
}

/**
 * A thread's state in a few words: "Needs approval" while one of its sessions
 * is blocked on a person, "Working" (shimmering) while one runs, otherwise what
 * the owner reported — "Needs input" or "Done". An open thread with nothing
 * running says nothing.
 */
export function ThreadStatusLabel({ status, running, needsApproval = false, className }: {
  status: ChannelThread['status']
  running: boolean
  needsApproval?: boolean
  className?: string
}) {
  if (needsApproval) {
    return (
      <span className={cn('flex shrink-0 items-center gap-1 text-status-warn', className)}>
        <ShieldAlert className="size-3" />
        <FormattedMessage id="channel.thread.status.needsApproval" defaultMessage="Needs approval" />
      </span>
    )
  }
  if (running) {
    return (
      <span className={cn('shrink-0 text-muted-foreground shimmer motion-reduce:shimmer-none', className)}>
        <FormattedMessage id="channel.thread.status.working" defaultMessage="Working" />
      </span>
    )
  }
  if (status === 'waiting') {
    return (
      <span className={cn('flex shrink-0 items-center gap-1 text-status-warn', className)}>
        <CircleAlert className="size-3" />
        <FormattedMessage id="channel.thread.status.waiting" defaultMessage="Needs input" />
      </span>
    )
  }
  if (status === 'done') {
    return (
      <span className={cn('flex shrink-0 items-center gap-1 text-status-ok', className)}>
        <Check className="size-3" />
        <FormattedMessage id="channel.thread.status.done" defaultMessage="Done" />
      </span>
    )
  }
  return null
}

function ActionButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
    >
      {icon}
    </button>
  )
}

function formatTime(ts: number): string {
  return formatDateTime(ts, { hour: '2-digit', minute: '2-digit' })
}

/** Same-day replies show just the clock; older ones add the date so "14:49" can't be mistaken for today. */
function formatReplyTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return formatTime(ts)
  return formatDateTime(d, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
