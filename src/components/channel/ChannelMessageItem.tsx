import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { Check, ChevronRight, Copy, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/format'
import type { ChannelMessage, Agent } from '@/types/channel'
import type { TaskListItem } from '@/types/task'
import { StatusIcon, TaskRef } from '@/components/task/task-meta'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { AgentAvatar } from '@/components/icons/AgentAvatar'

/** How long the copy button stays on its confirmed state. Matches the chat composer's. */
const COPIED_RESET_MS = 1500

const PROVIDER_NAME_COLOR: Record<string, string> = {
  'claude-code': 'text-[#C26B45] dark:text-[#E89572]',
  codex: 'text-[#10A37F] dark:text-[#3FBE9B]',
  opencode: 'text-[#7C5CD3] dark:text-[#A48BE6]',
  kimi: 'text-[#5165FF] dark:text-[#8794FF]',
  grok: 'text-[#1A1A1A] dark:text-[#E8E8E8]',
}

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
}

export const ChannelMessageItem = memo(function ChannelMessageItem({
  message,
  agents,
  grouped,
  onReply,
  tasks,
  onOpenTask,
  highlighted,
}: ChannelMessageItemProps) {
  const intl = useIntl()
  const isAgent = message.senderType === 'agent'
  const isSystem = message.senderType === 'system'

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
  const senderName = isAgent
    ? (agent?.name ?? message.senderName)
    : intl.formatMessage({ id: 'channel.message.you', defaultMessage: 'You' })

  const actions = (
    <div className={cn(
      'absolute -top-3.5 z-10 flex items-center gap-0.5 rounded-lg border border-border/60 bg-popover p-0.5 shadow-float dark:border-border/35',
      'opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto',
      isUser ? 'left-0' : 'right-2',
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
      {message.replyCount > 0 && (
        <ThreadSummary
          count={message.replyCount}
          lastReplyAt={message.lastReplyAt}
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
        <div className="relative max-w-[85%] md:max-w-[75%]">
          {actions}
          <div className="rounded-xl bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground phone:text-base">
            <MarkdownRenderer content={message.content} />
          </div>
        </div>
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
            <span className={cn('text-[13px] font-semibold', providerNameColor(agent?.provider))}>
              {senderName}
            </span>
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {formatTime(message.createdAt)}
            </span>
          </div>
        )}
        <div className="text-sm leading-relaxed text-foreground phone:text-base">
          <MarkdownRenderer content={message.content} />
        </div>
        {footer}
      </div>
    </div>
  )
})

/** Agent name color, by provider — a category color, so it stays a literal. */
export function providerNameColor(provider: string | undefined): string {
  return PROVIDER_NAME_COLOR[provider ?? ''] ?? 'text-tint'
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
 * Thread entry under a message. In a channel the clarifying questions and specs
 * live in the thread, so this is the one thing under a message that must not
 * be missed: a small bordered row with the count in link color.
 */
function ThreadSummary({ count, lastReplyAt, onClick }: { count: number; lastReplyAt: number | null | undefined; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/thread mt-1.5 flex max-w-full items-center gap-2 rounded-lg border border-border/50 bg-background px-2.5 py-1 text-xs transition-colors hover:bg-row-hover dark:border-border/35"
    >
      <MessageSquare className="size-3.5 shrink-0 text-link" />
      <span className="font-medium text-link">
        <FormattedMessage
          id="channel.message.replyCount"
          defaultMessage="{count, plural, one {# reply} other {# replies}}"
          values={{ count }}
        />
      </span>
      {lastReplyAt != null && (
        <span className="truncate text-muted-foreground/70 tabular-nums">
          <FormattedMessage
            id="channel.message.lastReply"
            defaultMessage="Last reply {time}"
            values={{ time: formatReplyTime(lastReplyAt) }}
          />
        </span>
      )}
      <ChevronRight className="-mr-1 size-3.5 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover/thread:opacity-100" />
    </button>
  )
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
