import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { Check, Copy, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChannelMessage, Agent } from '@/types/channel'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { AgentAvatar, UserAvatar } from './AgentAvatar'

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
}

export const ChannelMessageItem = memo(function ChannelMessageItem({
  message,
  agents,
  grouped,
  onReply,
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
    return (
      <div className="flex justify-center py-1">
        <span className="text-xs text-muted-foreground/60 bg-popover/70 border border-border/40 px-3 py-0.5 rounded-full">
          {message.content}
        </span>
      </div>
    )
  }

  const isUser = !isAgent

  const senderColor = isAgent ? PROVIDER_NAME_COLOR[agent?.provider ?? ''] ?? 'text-tint' : 'text-foreground'

  return (
    <div
      className={cn(
        'relative group px-2 md:px-4 transition-colors hover:bg-muted/10',
        grouped ? 'py-0.5' : 'pt-2 pb-0.5',
      )}
    >
      <div className={cn(
        'flex items-start gap-2.5 max-w-[88%] md:max-w-[78%]',
        isUser && 'ml-auto flex-row-reverse',
      )}>
        {/* Avatar — show on first message of a group, invisible spacer on subsequent */}
        {grouped ? (
          <div className="flex-none w-8" />
        ) : isAgent ? (
          <AgentAvatar provider={agent?.provider} size="md" />
        ) : (
          <UserAvatar size="md" />
        )}

        {/* Content */}
        <div className={cn('min-w-0', isUser && 'flex flex-col items-end')}>
          {/* Name + timestamp inline above bubble — only on first of a group */}
          {!grouped && (
            <div className={cn('flex items-baseline gap-2 mb-0.5 leading-none', isUser && 'flex-row-reverse')}>
              <span className={cn('text-[13px] font-semibold', senderColor)}>
                {isAgent
                  ? (agent?.name ?? message.senderName)
                  : (message.senderName || intl.formatMessage({ id: 'channel.message.you', defaultMessage: 'You' }))}
              </span>
              <span className="text-[10px] text-muted-foreground/50 tabular-nums">
                {formatTime(message.createdAt)}
              </span>
            </div>
          )}

          <div className="relative inline-block max-w-full">
            <div className={cn(
              'absolute top-0 z-10 flex items-center gap-0.5 rounded-lg border border-border/40 bg-popover/95 p-0.5 shadow-card backdrop-blur',
              'opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto',
              isUser ? 'right-full mr-1.5' : 'left-full ml-1.5',
            )}>
              <ActionButton icon={<MessageSquare className="w-3.5 h-3.5" />} label={intl.formatMessage({ id: 'channel.message.reply', defaultMessage: 'Reply' })} onClick={() => onReply(message.id)} />
              <ActionButton
                icon={copied
                  ? <Check className="w-3.5 h-3.5 text-green-500" />
                  : <Copy className="w-3.5 h-3.5" />}
                label={copied
                  ? intl.formatMessage({ id: 'common.copied', defaultMessage: 'Copied' })
                  : intl.formatMessage({ id: 'common.copy', defaultMessage: 'Copy' })}
                onClick={() => void handleCopy()}
              />
            </div>

            <div className={cn(
              'text-sm leading-relaxed rounded-2xl px-3.5 py-1.5',
              isAgent
                ? 'bg-popover/60 text-foreground border border-border/40 rounded-tl-md'
                : 'bg-muted/85 text-foreground rounded-tr-md',
            )}>
              <MarkdownRenderer content={message.content} />
            </div>
          </div>

          {message.replyCount > 0 && (
            <button
              onClick={() => onReply(message.id)}
              className={cn('flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-1', isUser && 'flex-row-reverse')}
            >
              <MessageSquare className="w-3 h-3" />
              <FormattedMessage
                id="channel.message.replyCount"
                defaultMessage="{count, plural, one {# reply} other {# replies}}"
                values={{ count: message.replyCount }}
              />
            </button>
          )}
        </div>
      </div>
    </div>
  )
})

function ActionButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
    >
      {icon}
    </button>
  )
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
