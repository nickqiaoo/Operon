import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { Send, Users, ChevronDown, Hash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from './AgentAvatar'
import { MentionPicker, detectMentionToken, useMentionMatches, useMentionState } from './MentionPicker'
import type { Agent } from '@/types/channel'
import { useChannelStore } from '@/stores/channel-store'
import { useChannel } from '@/hooks/useChannel'
import { ChannelMessageItem } from './ChannelMessageItem'
import { ThreadPanel } from './ThreadPanel'
import { ResizeHandle } from '@/components/app-shell/ResizeHandle'

interface ChannelChatProps {
  channelId: number
  onManageMembers?: () => void
  /**
   * Phone only: the soft keyboard is up. The composer already lifts itself via
   * `--keyboard-height`; this only tells the transcript to re-pin to the newest
   * message, since it just lost the keyboard's worth of height.
   */
  mobileKeyboardOpen?: boolean
}

// Thread side-panel width (desktop only; on phones it's a full-screen overlay).
// Drag the left edge to resize; the choice persists across reloads.
const THREAD_PANEL_MIN_WIDTH = 320
const THREAD_PANEL_MAX_WIDTH = 760
const THREAD_PANEL_DEFAULT_WIDTH = 440
const THREAD_PANEL_WIDTH_KEY = 'operon.channelThreadWidth'
const clampThreadWidth = (v: number) =>
  Math.max(THREAD_PANEL_MIN_WIDTH, Math.min(THREAD_PANEL_MAX_WIDTH, v))

export function ChannelChat({ channelId, onManageMembers, mobileKeyboardOpen = false }: ChannelChatProps) {
  const intl = useIntl()
  const [input, setInput] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const [newCount, setNewCount] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useMentionState()

  // Resizable thread panel width, restored from localStorage on first render.
  const threadWrapperRef = useRef<HTMLDivElement | null>(null)
  const [threadWidth, setThreadWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return THREAD_PANEL_DEFAULT_WIDTH
    const saved = Number(window.localStorage.getItem(THREAD_PANEL_WIDTH_KEY))
    return Number.isFinite(saved) && saved > 0 ? clampThreadWidth(saved) : THREAD_PANEL_DEFAULT_WIDTH
  })
  useEffect(() => {
    window.localStorage.setItem(THREAD_PANEL_WIDTH_KEY, String(threadWidth))
  }, [threadWidth])

  const agents = useChannelStore((s) => s.agents)
  const channels = useChannelStore((s) => s.channels)
  const members = useChannelStore((s) => s.members)
  const threadRootId = useChannelStore((s) => s.threadRootId)
  const setThreadRootId = useChannelStore((s) => s.setThreadRootId)
  const loadMembers = useChannelStore((s) => s.loadMembers)
  const channel = channels.find((c) => c.id === channelId) ?? null
  const channelMembers = members[channelId] ?? []
  const memberAgents = useMemo(
    () => channelMembers
      .map((m) => agents.find((a) => a.id === m.agentId))
      .filter((a): a is NonNullable<typeof a> => !!a),
    [channelMembers, agents],
  )

  const { messages, threadMessages, typingAgentIds, loading, loadingMore, hasMore, loadMore, sendMessage, sendThreadReply } = useChannel({
    channelId,
  })

  useEffect(() => {
    void loadMembers(channelId)
  }, [channelId, loadMembers])

  // Auto-scroll: initial load goes to bottom; new tail messages only auto-scroll
  // when the user is near the bottom; prepended history must not be counted as
  // "new" or trigger an auto-scroll.
  const prevLengthRef = useRef(0)
  const prevFirstIdRef = useRef<number | null>(null)
  const prevScrollHeightRef = useRef(0)
  useEffect(() => {
    const prev = prevLengthRef.current
    const cur = messages.length
    const prevFirstId = prevFirstIdRef.current
    const firstId = messages[0]?.id ?? null
    const isFirstLoad = prev === 0 && cur > 0
    const diff = cur - prev
    const isPrepend = prev > 0 && diff > 0 && prevFirstId !== null && firstId !== null && firstId < prevFirstId

    if (isFirstLoad) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' })
      setAtBottom(true)
      setNewCount(0)
    } else if (isPrepend) {
      // Older messages prepended — keep the same content under the viewport.
      const el = scrollRef.current
      if (el) {
        el.scrollTop += el.scrollHeight - prevScrollHeightRef.current
      }
    } else if (diff > 0) {
      if (atBottom) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
        setNewCount(0)
      } else {
        setNewCount((n) => n + diff)
      }
    }

    // Snapshot at the end so the next run compares against this run's values.
    prevLengthRef.current = cur
    prevFirstIdRef.current = firstId
    if (scrollRef.current) {
      prevScrollHeightRef.current = scrollRef.current.scrollHeight
    }
  }, [messages, atBottom])

  // Opening the keyboard shrinks the transcript by the keyboard's height, which
  // leaves a reader who was at the bottom looking at older messages. Re-pin —
  // but only on the keyboard toggle, hence the ref: `atBottom` in the deps would
  // fight the user every time they scrolled back down.
  const atBottomRef = useRef(atBottom)
  useEffect(() => {
    atBottomRef.current = atBottom
  }, [atBottom])
  useEffect(() => {
    if (!atBottomRef.current) return
    // Next frame: the layout has to settle at the new height first.
    const frame = requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'instant' }))
    return () => cancelAnimationFrame(frame)
  }, [mobileKeyboardOpen])

  // Track whether scroll viewport is at the bottom, and load more at top
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const isNearBottom = distFromBottom < 80
    setAtBottom(isNearBottom)
    if (isNearBottom) setNewCount(0)

    // Load more when scrolled near the top
    if (el.scrollTop < 100 && hasMore && !loadingMore) {
      void loadMore()
    }
  }, [hasMore, loadingMore, loadMore])

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    setAtBottom(true)
    setNewCount(0)
  }

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    setMention((s) => ({ ...s, open: false }))
    await sendMessage(text)
  }, [input, sendMessage, setMention])

  const mentionMatches = useMentionMatches(memberAgents, mention.query)

  const insertMention = useCallback((agent: Agent) => {
    const el = textareaRef.current
    if (!el) return
    const value = el.value
    const caret = el.selectionStart ?? value.length
    const detected = detectMentionToken(value, caret)
    const atIndex = detected?.atIndex ?? mention.atIndex
    if (atIndex < 0) return
    const before = value.slice(0, atIndex)
    const after = value.slice(caret)
    const insertion = `@${agent.name} `
    const next = before + insertion + after
    setInput(next)
    setMention({ open: false, query: '', atIndex: -1, selectedIndex: 0 })
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const cursor = before.length + insertion.length
      node.focus()
      node.setSelectionRange(cursor, cursor)
    })
  }, [mention.atIndex, setMention])

  const updateMentionFromCaret = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart ?? el.value.length
    const detected = detectMentionToken(el.value, caret)
    if (!detected) {
      setMention((s) => (s.open ? { ...s, open: false } : s))
      return
    }
    setMention((s) => ({
      open: true,
      query: detected.query,
      atIndex: detected.atIndex,
      selectedIndex: s.open && s.atIndex === detected.atIndex ? s.selectedIndex : 0,
    }))
  }, [setMention])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    // Defer to next tick so selectionStart reflects post-change caret position.
    requestAnimationFrame(updateMentionFromCaret)
  }, [updateMentionFromCaret])

  // Auto-grow the composer to fit its content, up to the CSS max-height (then it
  // scrolls). Reset to 'auto' first so it also shrinks back when text is removed.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [input])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.open && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMention((s) => ({ ...s, selectedIndex: (s.selectedIndex + 1) % mentionMatches.length }))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMention((s) => ({ ...s, selectedIndex: (s.selectedIndex - 1 + mentionMatches.length) % mentionMatches.length }))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (!e.nativeEvent.isComposing) {
          e.preventDefault()
          insertMention(mentionMatches[mention.selectedIndex] ?? mentionMatches[0])
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention((s) => ({ ...s, open: false }))
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void handleSend()
    }
  }, [mention.open, mention.selectedIndex, mentionMatches, insertMention, setMention, handleSend])

  const handleReply = useCallback((id: number) => setThreadRootId(id), [setThreadRootId])

  const rootMessage = threadRootId
    ? messages.find((m) => m.id === threadRootId) ?? null
    : null

  const showRightPanel = threadRootId

  return (
    <div className="flex h-full min-h-0">
      {/* Main area */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Channel meta row */}
        {/* h-10 is fixed, not padding-derived: this row carries a 24px MemberStack
            that used to push it to 52px while the thread header stayed at 40, so
            the two bottom borders sat 12px apart. Keep both headers on h-10. */}
        <div className="flex h-10 items-center gap-3 border-b border-border/40 px-3 md:px-5 shrink-0 bg-background">
          <Hash className="w-4 h-4 text-muted-foreground/70 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold truncate">{channel?.name ?? intl.formatMessage({ id: 'channel.untitled', defaultMessage: 'channel' })}</h2>
              {channel?.description && (
                <span className="text-xs text-muted-foreground/70 truncate">{channel.description}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onManageMembers}
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors rounded-full px-1.5 py-1 hover:bg-muted/45"
            title={intl.formatMessage({ id: 'channel.manageMembers', defaultMessage: 'Manage members' })}
          >
            <MemberStack agents={memberAgents} />
            {memberAgents.length === 0 && <Users className="w-3.5 h-3.5" />}
            <span className="font-medium tabular-nums">{memberAgents.length}</span>
          </button>
        </div>

        {/* Messages */}
            <div className="flex-1 min-h-0 relative overflow-hidden">
              <div
                ref={scrollRef}
                className="h-full overflow-y-auto overflow-x-hidden code-scrollbar"
                onScroll={handleScroll}
              >
                {loading ? (
                  <div className="flex items-center justify-center h-24 text-xs text-muted-foreground/50">
                    <FormattedMessage id="common.loading" defaultMessage="Loading…" />
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-32 text-muted-foreground/50 gap-1">
                    <p className="text-sm"><FormattedMessage id="channel.empty.noMessages" defaultMessage="No messages yet" /></p>
                    <p className="text-xs"><FormattedMessage id="channel.empty.startConversation" defaultMessage="Start a conversation" /></p>
                  </div>
                ) : (
                  <div className="py-4 max-w-4xl mx-auto px-2 md:px-4">
                    {loadingMore && (
                      <div className="flex items-center justify-center h-10 text-xs text-muted-foreground/50">
                        <FormattedMessage id="channel.loadingOlder" defaultMessage="Loading older messages..." />
                      </div>
                    )}
                    {messages.map((msg, idx) => {
                      const prev = messages[idx - 1]
                      const grouped = !!prev
                        && prev.senderType === msg.senderType
                        && prev.senderId === msg.senderId
                        && prev.senderType !== 'system'
                        && msg.createdAt - prev.createdAt < 5 * 60 * 1000
                      return (
                        <ChannelMessageItem
                          key={msg.id}
                          message={msg}
                          agents={agents}
                          grouped={grouped}
                          onReply={handleReply}
                        />
                      )
                    })}
                    {/* Typing indicators */}
                    {[...typingAgentIds].map((agentId) => {
                      const agent = agents.find((a) => a.id === agentId)
                      return (
                        <div key={agentId} className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground/60">
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
                )}
              </div>

              {/* "N new messages" pill */}
              {!atBottom && newCount > 0 && (
                <button
                  onClick={scrollToBottom}
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-tint text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-float hover:opacity-90 transition-opacity"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                  <FormattedMessage
                    id="channel.newMessages"
                    defaultMessage="{count, plural, one {# new message} other {# new messages}}"
                    values={{ count: newCount }}
                  />
                </button>
              )}

              {/* Scroll to bottom button when not at bottom (no new msgs) */}
              {!atBottom && newCount === 0 && (
                <button
                  onClick={scrollToBottom}
                  className="absolute bottom-3 right-4 flex items-center justify-center w-8 h-8 bg-popover/90 border border-border/40 rounded-full shadow-card text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronDown className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Input */}
            {/* Same as the thread composer: the input's own border is the edge. */}
            {/* The extra bottom padding is the phone keyboard (0 everywhere
                else): the shell keeps its full height with the keyboard as an
                overlay, so the composer has to make room for it itself. The
                transcript above is `flex-1`, so it gives up exactly that much. */}
            <div className="shrink-0 p-3 pb-[calc(0.75rem+var(--keyboard-height))]">
              <div className="relative max-w-4xl mx-auto flex items-end gap-2 bg-popover/90 border border-border/60 rounded-xl px-3 py-2.5 shadow-input dark:border-border/35 dark:bg-popover/85">
                {mention.open && (
                  <MentionPicker
                    agents={mentionMatches}
                    query={mention.query}
                    selectedIndex={mention.selectedIndex}
                    onSelect={insertMention}
                    onHoverIndex={(idx) => setMention((s) => ({ ...s, selectedIndex: idx }))}
                  />
                )}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onKeyUp={updateMentionFromCaret}
                  onClick={updateMentionFromCaret}
                  onBlur={() => setMention((s) => ({ ...s, open: false }))}
                  placeholder={intl.formatMessage({ id: 'channel.inputPlaceholder', defaultMessage: 'Message this channel... (type @ to mention)' })}
                  rows={1}
                  className="flex-1 bg-transparent text-sm leading-6 resize-none outline-none text-foreground placeholder:text-muted-foreground/40 max-h-40 min-h-[2.25rem] overflow-y-auto py-1"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleSend()}
                  disabled={!input.trim()}
                  className="h-9 px-3 gap-1.5 text-xs shrink-0"
                >
                  <Send className="w-3 h-3" />
                  <FormattedMessage id="common.send" defaultMessage="Send" />
                </Button>
              </div>
            </div>
      </div>

      {/* Thread — side panel at md+, full-screen overlay on phones (a narrow
          screen can't fit the conversation and the thread side by side) */}
      {showRightPanel && (
        <div
          ref={threadWrapperRef}
          className="fixed inset-0 z-50 flex flex-col min-h-0 bg-background md:relative md:z-auto md:w-[var(--thread-w)] md:shrink-0 md:bg-transparent"
          style={{
            paddingTop: "env(safe-area-inset-top)",
            // With the phone keyboard up, it covers the home-indicator strip, so
            // the two insets don't stack — take whichever is taller.
            paddingBottom: "max(env(safe-area-inset-bottom), var(--keyboard-height))",
            "--thread-w": `${threadWidth}px`,
          } as React.CSSProperties}
        >
          {/* Drag the left edge to resize (desktop only; phones show it full-screen). */}
          <div className="hidden md:contents">
            <ResizeHandle
              edge="left"
              defaultSize={THREAD_PANEL_DEFAULT_WIDTH}
              getSizeFromPointer={({ x }) => {
                const right = threadWrapperRef.current?.getBoundingClientRect().right ?? 0
                return right - x
              }}
              setSize={(next) => setThreadWidth(clampThreadWidth(next))}
            />
          </div>
          {threadRootId && (
            <ThreadPanel
              rootMessage={rootMessage}
              replies={threadMessages}
              agents={agents}
              typingAgentIds={typingAgentIds}
              onClose={() => setThreadRootId(null)}
              onSendReply={(text) => void sendThreadReply(text)}
              mobileKeyboardOpen={mobileKeyboardOpen}
            />
          )}
        </div>
      )}
    </div>
  )
}

function MemberStack({ agents }: { agents: { id: number; provider: string }[] }) {
  const visible = agents.slice(0, 3)
  const extra = agents.length - visible.length
  if (agents.length === 0) return null
  return (
    <div className="flex -space-x-2">
      {visible.map((a) => (
        <div key={a.id} className="ring-2 ring-background rounded-full">
          <AgentAvatar provider={a.provider} size="sm" />
        </div>
      ))}
      {extra > 0 && (
        <div className="flex-none flex items-center justify-center w-6 h-6 rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-2 ring-background">
          +{extra}
        </div>
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
