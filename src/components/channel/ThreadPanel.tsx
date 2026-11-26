import { useRef, useEffect, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { ArrowLeft, Loader2, UserMinus, X } from 'lucide-react'
import { AgentAvatar, UserAvatar } from '@/components/icons/AgentAvatar'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/format'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { SendFailed, ThreadStatusLabel, useAgentMentions } from './ChannelMessageItem'
import { agentNameColor } from './agent-name-color'
import { SessionApprovals } from './SessionApprovals'
import { COMPOSER_TEXTAREA_CLASS, ComposerAttachButton, ComposerFrame, ComposerSendButton } from './ComposerFrame'
import { PendingImageStrip } from '@/components/task/task-attachments'
import { useChannelComposer } from './useChannelComposer'
import { ChannelImages } from './ChannelImages'
import type { ChannelAttachment, ChannelMessage, ChannelThread, Agent } from '@/types/channel'
import { useIsMobileShell } from '@/hooks/useIsMobile'
import { hasNativeComposer } from '@/lib/native-composer'
import { NativeChatComposer } from '@/components/mobile/NativeChatComposer'

interface ThreadPanelProps {
  nativeComposerActive: boolean
  /** Which channel the thread belongs to — shown in the header so a resized or long-open panel keeps its context. */
  channelName: string | null
  rootMessage: ChannelMessage | null
  /** The thread's owner and state; absent until the thread has been started. */
  thread?: ChannelThread
  replies: ChannelMessage[]
  agents: Agent[]
  typingAgentIds: Set<number>
  onClose: () => void
  onSendReply: (content: string, attachments: ChannelAttachment[]) => Promise<void>
  /** For your reply that failed to send. */
  onRetrySend?: (localId: number) => void
  onDiscardSend?: (localId: number) => void
  /**
   * Phone only: the soft keyboard is up. The panel's wrapper already lifts the
   * whole column clear of it; this just re-pins the reply list to the bottom
   * after it loses that height.
   */
  mobileKeyboardOpen?: boolean
}

export function ThreadPanel({
  nativeComposerActive,
  channelName,
  rootMessage,
  thread,
  replies,
  agents,
  typingAgentIds,
  onClose,
  onSendReply,
  onRetrySend,
  onDiscardSend,
  mobileKeyboardOpen = false,
}: ThreadPanelProps) {
  const intl = useIntl()
  const { input, setInput, images, canSend, submit } = useChannelComposer(onSendReply)
  const isMobile = useIsMobileShell()
  const nativeComposer = isMobile && hasNativeComposer()
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const viewport = bottomRef.current?.closest('[data-slot="scroll-area-viewport"]')
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
  }, [replies, mobileKeyboardOpen])

  const handleSend = (text?: string) => {
    if (submit(text) && isMobile) textareaRef.current?.blur()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void handleSend()
    }
  }

  if (!rootMessage) return null

  const running = (thread?.activeAgentIds.length ?? 0) > 0
  // Owner first, then the members in the order they came in.
  const memberIds = thread
    ? [...new Set([...(thread.ownerAgentId != null ? [thread.ownerAgentId] : []), ...thread.participantAgentIds])]
    : []
  const members = memberIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => a != null)

  return (
    // On a phone the thread is a full-screen page whose wrapper paints the safe
    // areas in the page color; a sidebar-colored panel inside it read as three bands.
    <div className="flex flex-col h-full bg-background md:border-l md:border-border/50 dark:md:border-border/35">
      {/* Header — fixed h-10, matching the channel header on the left so both
          bottom borders land on the same line regardless of their contents. */}
      <div className="flex h-10 items-center justify-between gap-2 px-3 md:px-4 border-b border-border/40 shrink-0 bg-background">
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
        {thread && (members.length > 0 || running || thread.status !== 'open' || thread.waiting.length > 0) && (
          <div className="flex min-w-0 shrink items-center gap-2 text-xs">
            <ThreadStatusLabel status={thread.status} running={running} needsApproval={thread.waiting.length > 0} />
            {members.length > 0 && <ThreadMembers thread={thread} members={members} />}
          </div>
        )}
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

      <ScrollArea className="flex-1 min-h-0" viewportClassName="scroll-fade-y [--scroll-fade-gutter:0px]">
        <div className="space-y-4 p-4">
          {/* Root message */}
          <MessageBubble message={rootMessage} agents={agents} isRoot />

          {/* What the owner last reported, so a long thread can be read from the top. */}
          {thread?.summary && (
            <div className="rounded-lg border border-border/40 bg-muted/40 px-3 py-2 text-xs text-muted-foreground dark:border-border/35">
              <span className="font-medium text-foreground/85">
                <FormattedMessage id="channel.thread.summary" defaultMessage="Summary" />
              </span>
              <span aria-hidden="true"> · </span>
              {thread.summary}
            </div>
          )}

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
            <MessageBubble key={msg.id} message={msg} agents={agents} onRetrySend={onRetrySend} onDiscardSend={onDiscardSend} />
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
      {/* No top padding: the replies fade into the composer instead. */}
      <div className="shrink-0 px-3 pb-3">
        {thread && thread.waiting.length > 0 && (
          <div className="mb-2">
            <SessionApprovals waiting={thread.waiting} agents={agents} />
          </div>
        )}
        {images.items.length > 0 && <PendingImageStrip uploads={images} className="mb-2" />}
        {nativeComposer ? (
          <NativeChatComposer
            active={nativeComposerActive}
            value={input}
            onChange={setInput}
            onSubmit={(text) => void handleSend(text)}
            onFiles={images.addFiles}
            hasContext={images.items.length > 0}
            keepTextOnSend
            submitting={images.uploading}
            placeholder="Reply in thread…"
            overlayLevel={1}
          />
        ) : (
          <ComposerFrame {...images.inputProps}>
            <ComposerAttachButton onFiles={images.addFiles} />
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={intl.formatMessage({ id: 'channel.thread.replyPlaceholder', defaultMessage: 'Reply in thread...' })}
              rows={1}
              className={COMPOSER_TEXTAREA_CLASS}
            />
            <ComposerSendButton disabled={!canSend} onClick={() => void handleSend()} />
          </ComposerFrame>
        )}
      </div>
    </div>
  )
}

/**
 * Who is in the thread — everyone here hears every reply, as in a channel.
 * Opens a list to take a member out.
 */
function ThreadMembers({ thread, members }: { thread: ChannelThread; members: Agent[] }) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const visible = members.slice(0, 3)
  const extra = members.length - visible.length

  const remove = async (agentId: number) => {
    setRemoving(agentId)
    setFailed(false)
    try {
      // The thread_updated event that follows refreshes the member list.
      await api.channelThreadMemberRemove(thread.channelId, thread.rootMessageId, agentId)
    } catch {
      setFailed(true)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setFailed(false) }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group/members flex h-7 shrink-0 items-center rounded-lg px-1.5 transition-colors hover:bg-secondary-hover"
          title={intl.formatMessage({ id: 'channel.thread.members', defaultMessage: 'Thread members' })}
          aria-label={intl.formatMessage({ id: 'channel.thread.members', defaultMessage: 'Thread members' })}
        >
          {/* Side by side, not overlapped: bare logos have no disc to stack. */}
          <span className="flex items-center gap-0.5">
            {visible.map((a) => (
              <span key={a.id} className="relative">
                <AgentAvatar provider={a.provider} size="sm" className="size-5" />
                {thread.activeAgentIds.includes(a.id) && (
                  <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-status-ok ring-2 ring-background" />
                )}
              </span>
            ))}
            {extra > 0 && (
              <span className="pl-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                +{extra}
              </span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1">
        <div className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">
          <FormattedMessage id="channel.thread.membersHint" defaultMessage="Everyone here hears every reply. @mention an agent to bring them in." />
        </div>
        {members.map((a) => {
          const isOwner = a.id === thread.ownerAgentId
          return (
            <div key={a.id} className="group/row flex h-8 items-center gap-2 rounded-lg px-2 text-sm hover:bg-row-hover">
              <AgentAvatar provider={a.provider} size="sm" className="size-4 shrink-0" />
              <span className={cn('min-w-0 flex-1 truncate', agentNameColor(a.id))}>{a.name}</span>
              {thread.activeAgentIds.includes(a.id) && (
                <span className="text-[11px] text-status-ok">
                  <FormattedMessage id="channel.thread.memberRunning" defaultMessage="Working" />
                </span>
              )}
              {isOwner && (
                <span className="text-[11px] text-muted-foreground">
                  <FormattedMessage id="channel.thread.ownerBadge" defaultMessage="Owner" />
                </span>
              )}
              <button
                type="button"
                onClick={() => void remove(a.id)}
                disabled={removing != null}
                title={intl.formatMessage({ id: 'channel.thread.removeMember', defaultMessage: 'Remove from thread' })}
                aria-label={intl.formatMessage({ id: 'channel.thread.removeMemberNamed', defaultMessage: 'Remove {name} from thread' }, { name: a.name })}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent-hover hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 disabled:opacity-50 phone:opacity-100"
              >
                {removing === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserMinus className="h-3.5 w-3.5" />}
              </button>
            </div>
          )
        })}
        {failed && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-destructive">
            <FormattedMessage id="channel.thread.removeFailed" defaultMessage="Couldn't remove that member. Try again." />
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Hiragana/katakana, CJK ideographs, Hangul: scripts that ink high in a Latin-metric line box. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/

/**
 * Move the 16px icon to where the name's ink is: up 1px for CJK, which inks
 * high; down half a pixel for Latin, whose x-height letters ink low.
 */
function nameNudge(name: string): string {
  return CJK.test(name) ? '-translate-y-px' : 'translate-y-[0.5px]'
}

function MessageBubble({ message, agents, isRoot = false, onRetrySend, onDiscardSend }: {
  message: ChannelMessage
  agents: Agent[]
  isRoot?: boolean
  onRetrySend?: (localId: number) => void
  onDiscardSend?: (localId: number) => void
}) {
  const intl = useIntl()
  const isAgent = message.senderType === 'agent'
  const isSystem = message.senderType === 'system'
  const agent = isAgent && message.senderId ? agents.find((a) => a.id === message.senderId) : null
  const mentions = useAgentMentions(agents)

  if (isSystem) {
    return <div className="text-center text-xs text-muted-foreground/70">{message.content}</div>
  }

  const name = isAgent
    ? (agent?.name ?? message.senderName)
    : intl.formatMessage({ id: 'channel.message.you', defaultMessage: 'You' })

  return (
    <div className={cn('min-w-0 transition-opacity', isRoot && 'pb-4 border-b border-border/40', message.localState === 'sending' && 'opacity-60')}>
      {/* Avatar + name + time on one header row, so the body below can span the
          panel's full width instead of being inset under an avatar gutter. */}
      {/* The avatar box is the icon's own size (no padding ring): a size-7 box
          around a 16px logo left 6px of blank on each side, so the name sat
          ~16px away and the logo was inset from the body text below.
          The boxes are centred, but where the glyphs sit in the line box
          depends on the script: CJK ("你") inks ~1.3px above centre, Latin
          ("You", "luna-dev") ~0.4px below it. One fixed nudge fixed one and
          broke the other (measured: "You" 0.66px, agent names 0.99px off),
          so it follows the name (nameNudge). */}
      <div className="mb-1.5 flex items-center gap-2">
        {isAgent
          ? <AgentAvatar provider={agent?.provider} size="sm" className={cn('size-4', nameNudge(name))} />
          : <UserAvatar size="sm" className={cn('size-4', nameNudge(name))} />}
        <span className={cn('text-[13px] font-semibold', isAgent ? agentNameColor(agent?.id) : 'text-foreground')}>
          {name}
        </span>
        <span className="text-[11px] text-muted-foreground/60 tabular-nums">
          {formatDateTime(message.createdAt, { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      {message.content.trim() && (
        <div className="text-sm leading-relaxed text-foreground break-words phone:text-base">
          <MarkdownRenderer content={message.content} mentions={mentions} />
        </div>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <ChannelImages attachments={message.attachments} className={message.content.trim() ? 'mt-2' : undefined} />
      )}
      {message.localState === 'failed' && (
        <SendFailed className="pr-0" onRetry={() => onRetrySend?.(message.id)} onDiscard={() => onDiscardSend?.(message.id)} />
      )}
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
