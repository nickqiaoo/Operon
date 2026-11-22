import { useRef, useEffect, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { ArrowLeft, X } from 'lucide-react'
import { AgentAvatar, UserAvatar } from '@/components/icons/AgentAvatar'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/format'
import { ScrollArea } from '@/components/ui/scroll-area'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { providerNameColor } from './ChannelMessageItem'
import { COMPOSER_TEXTAREA_CLASS, ComposerFrame, ComposerSendButton } from './ComposerFrame'
import type { ChannelMessage, Agent } from '@/types/channel'
import { useIsMobileShell } from '@/hooks/useIsMobile'
import { hasNativeComposer } from '@/lib/native-composer'
import { NativeChatComposer } from '@/components/mobile/NativeChatComposer'

interface ThreadPanelProps {
  /** Which channel the thread belongs to — shown in the header so a resized or long-open panel keeps its context. */
  channelName: string | null
  rootMessage: ChannelMessage | null
  replies: ChannelMessage[]
  agents: Agent[]
  typingAgentIds: Set<number>
  onClose: () => void
  onSendReply: (content: string) => void
  /**
   * Phone only: the soft keyboard is up. The panel's wrapper already lifts the
   * whole column clear of it; this just re-pins the reply list to the bottom
   * after it loses that height.
   */
  mobileKeyboardOpen?: boolean
}

export function ThreadPanel({
  channelName,
  rootMessage,
  replies,
  agents,
  typingAgentIds,
  onClose,
  onSendReply,
  mobileKeyboardOpen = false,
}: ThreadPanelProps) {
  const intl = useIntl()
  const [input, setInput] = useState('')
  const isMobile = useIsMobileShell()
  const nativeComposer = isMobile && hasNativeComposer()
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [replies, mobileKeyboardOpen])

  const handleSend = () => {
    const text = input.trim()
    if (!text) return
    onSendReply(text)
    setInput('')
    // Phone: sending ends the typing, so the keyboard goes. (UIKit does its own.)
    if (isMobile) textareaRef.current?.blur()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!rootMessage) return null

  return (
    // On a phone the thread is a full-screen page whose wrapper paints the safe
    // areas in the page color; a sidebar-colored panel inside it read as three bands.
    <div className="flex flex-col h-full bg-background md:border-l md:border-border/40 md:bg-sidebar">
      {/* Header — fixed h-10, matching the channel header on the left so both
          bottom borders land on the same line regardless of their contents. */}
      <div className="flex h-10 items-center justify-between gap-2 px-3 md:px-4 border-b border-border/40 shrink-0 bg-background md:bg-sidebar">
        {/* Phone: a page you go back from, like every other one pushed over a list. */}
        <button
          type="button"
          onClick={onClose}
          aria-label={intl.formatMessage({ id: 'common.back', defaultMessage: 'Back' })}
          className="-ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground md:hidden"
        >
          <ArrowLeft className="h-[18px] w-[18px]" />
        </button>
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="text-sm font-semibold text-foreground shrink-0">
            <FormattedMessage id="channel.thread.title" defaultMessage="Thread" />
          </span>
          {channelName && (
            <span className="truncate text-xs text-muted-foreground/70">
              <span aria-hidden="true">· </span>#{channelName}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          title={intl.formatMessage({ id: 'common.close', defaultMessage: 'Close' })}
          aria-label={intl.formatMessage({ id: 'common.close', defaultMessage: 'Close' })}
          className="-mr-1.5 hidden size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground md:flex"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-4 p-4">
          {/* Root message */}
          <MessageBubble message={rootMessage} agents={agents} isRoot />

          {replies.length > 0 && (
            <div className="flex items-center gap-3 text-xs font-medium text-muted-foreground/70">
              <span className="shrink-0">
                <FormattedMessage
                  id="channel.message.replyCount"
                  defaultMessage="{count, plural, one {# reply} other {# replies}}"
                  values={{ count: replies.length }}
                />
              </span>
              <span className="h-px flex-1 bg-border/50 dark:bg-border/35" />
            </div>
          )}

          {/* Replies */}
          {replies.map((msg) => (
            <MessageBubble key={msg.id} message={msg} agents={agents} />
          ))}

          {/* Typing indicators */}
          {[...typingAgentIds].map((agentId) => {
            const agent = agents.find((a) => a.id === agentId)
            return (
              <div key={agentId} className="flex items-center gap-2.5 text-xs text-muted-foreground/70">
                <AgentAvatar provider={agent?.provider} size="sm" className="size-7" />
                <span>
                  <FormattedMessage
                    id="channel.typing"
                    defaultMessage="{name} is typing"
                    values={{ name: agent?.name ?? intl.formatMessage({ id: 'channel.agentFallback', defaultMessage: 'Agent' }) }}
                  />
                </span>
                <TypingDots />
              </div>
            )
          })}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Reply input — the same ComposerFrame as the channel composer. */}
      {/* No top border: the composer already has its own rounded border, so a
          rule above it is a second divider doing the same job. */}
      <div className="shrink-0 p-3">
        {nativeComposer ? <NativeChatComposer
          value={input}
          onChange={setInput}
          onSubmit={handleSend}
          placeholder="Reply in thread…"
          overlayLevel={1}
        /> : <ComposerFrame>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={intl.formatMessage({ id: 'channel.thread.replyPlaceholder', defaultMessage: 'Reply in thread...' })}
            rows={1}
            className={COMPOSER_TEXTAREA_CLASS}
          />
          <ComposerSendButton disabled={!input.trim()} onClick={handleSend} />
        </ComposerFrame>}
      </div>
    </div>
  )
}

function MessageBubble({ message, agents, isRoot = false }: { message: ChannelMessage; agents: Agent[]; isRoot?: boolean }) {
  const intl = useIntl()
  const isAgent = message.senderType === 'agent'
  const isSystem = message.senderType === 'system'
  const agent = isAgent && message.senderId ? agents.find((a) => a.id === message.senderId) : null

  if (isSystem) {
    return <div className="text-center text-xs text-muted-foreground/70">{message.content}</div>
  }

  const name = isAgent
    ? (agent?.name ?? message.senderName)
    : intl.formatMessage({ id: 'channel.message.you', defaultMessage: 'You' })

  return (
    <div className={cn('min-w-0', isRoot && 'pb-4 border-b border-border/40')}>
      {/* Avatar + name + time on one header row, so the body below can span the
          panel's full width instead of being inset under an avatar gutter. */}
      <div className="mb-1.5 flex items-center gap-2.5">
        {isAgent
          ? <AgentAvatar provider={agent?.provider} size="sm" className="size-7" />
          : <UserAvatar size="sm" className="size-7" />}
        <span className={cn('text-[13px] font-semibold', isAgent ? providerNameColor(agent?.provider) : 'text-foreground')}>
          {name}
        </span>
        <span className="text-[11px] text-muted-foreground/60 tabular-nums">
          {formatDateTime(message.createdAt, { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div className="text-sm leading-relaxed text-foreground break-words phone:text-base">
        <MarkdownRenderer content={message.content} />
      </div>
    </div>
  )
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1 h-1 rounded-full bg-muted-foreground/40 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  )
}
