import { useRef, useEffect, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { X, Send } from 'lucide-react'
import { AgentAvatar, UserAvatar } from './AgentAvatar'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import type { ChannelMessage, Agent } from '@/types/channel'

interface ThreadPanelProps {
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
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [replies, mobileKeyboardOpen])

  const handleSend = () => {
    const text = input.trim()
    if (!text) return
    onSendReply(text)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!rootMessage) return null

  return (
    <div className="flex flex-col h-full border-l border-border/40 bg-sidebar">
      {/* Header — fixed h-10, matching the channel header on the left so both
          bottom borders land on the same line regardless of their contents. */}
      <div className="flex h-10 items-center justify-between px-4 border-b border-border/40 shrink-0 bg-sidebar">
        <span className="text-sm font-semibold text-foreground">
          <FormattedMessage id="channel.thread.title" defaultMessage="Thread" />
        </span>
        <Button variant="ghost" size="icon" className="h-5 w-5 rounded-full text-muted-foreground hover:bg-muted/50" onClick={onClose}>
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-3">
          {/* Root message */}
          <MessageBubble message={rootMessage} agents={agents} isRoot />

          {replies.length > 0 && (
            <div className="text-xs text-muted-foreground/60 font-medium py-1">
              <FormattedMessage
                id="channel.message.replyCount"
                defaultMessage="{count, plural, one {# reply} other {# replies}}"
                values={{ count: replies.length }}
              />
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
              <div key={agentId} className="flex items-center gap-2 text-xs text-muted-foreground/60">
                <AgentAvatar provider={agent?.provider} size="sm" />
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

      {/* Reply input */}
      {/* No top border: the composer already has its own rounded border, so a
          rule above it is a second divider doing the same job. */}
      <div className="shrink-0 p-3">
        <div className="flex items-end gap-2 bg-popover/80 border border-border/40 rounded-lg px-3 py-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={intl.formatMessage({ id: 'channel.thread.replyPlaceholder', defaultMessage: 'Reply in thread...' })}
            rows={1}
            className="flex-1 bg-transparent text-sm resize-none outline-none text-foreground placeholder:text-muted-foreground/50 max-h-32"
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={handleSend}
            disabled={!input.trim()}
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-tint disabled:opacity-30"
          >
            <Send className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ message, agents, isRoot = false }: { message: ChannelMessage; agents: Agent[]; isRoot?: boolean }) {
  const isAgent = message.senderType === 'agent'
  const agent = isAgent && message.senderId ? agents.find((a) => a.id === message.senderId) : null

  return (
    <div className={cn('min-w-0', isRoot && 'pb-3 border-b border-border/40')}>
      {/* Avatar + name + time on one header row, so the body below can span the
          full width and keep equal left/right margins (the parent's p-4) instead
          of being inset under an avatar gutter. */}
      <div className="flex items-center gap-2 mb-1">
        {isAgent ? <AgentAvatar provider={agent?.provider} size="sm" /> : <UserAvatar size="sm" />}
        <span className={cn('text-xs font-semibold', isAgent ? 'text-tint' : 'text-foreground')}>
          {agent?.name ?? message.senderName}
        </span>
        <span className="text-[10px] text-muted-foreground/50">
          {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div className="text-sm text-foreground/90 leading-relaxed break-words">
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
