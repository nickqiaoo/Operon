import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { BookmarkCheck, PaperclipIcon } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { Attachment, AttachmentPreview, AttachmentRemove, Attachments } from "@/components/ai-elements/attachments"
import { Conversation, ConversationContent, ConversationItem, ConversationScrollButton, useConversationScroll } from "@/components/ai-elements/conversation"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { Button } from "@/components/ui/button"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { InputGroupAddon } from "@/components/ui/input-group"
import { cn } from "@/lib/utils"
import type { ActivitySummary, AssistantApproval, AssistantAttachment, AssistantMessage } from "./types"
import { CodingAgentCard, CodingChip } from "./CodingAgentCard"
import { AuditIconTile, formatClock, isSameDay } from "./shared"
import { auditDetail, dayLabel, messageText } from "./assistant-i18n"
import { hasNativeComposer } from "@/lib/native-composer"
import { NativePromptComposer } from "@/components/mobile/NativeChatComposer"

/** Messages further apart than this get a time label between them (same day). */
const TIME_GAP_MS = 30 * 60_000

/**
 * Messages out of view skip layout and paint (as in the chat's MessagesList): the elements stay
 * in the DOM, so find-in-page and the stick-to-bottom scroller keep working. The browser remembers
 * each one's measured height once shown; the fallback is for those never shown yet.
 *
 * Not on the phone: WebKit has no scroll anchoring, so a message first laid out above the
 * viewport (fallback → real height) shoves what the reader is looking at, and each of those
 * resizes makes the stick-to-bottom scroller ignore the swipe and pull back to the bottom.
 * The thread there is paged and trimmed, so there is little to skip anyway.
 */
const OFFSCREEN_DEFER_STYLE: CSSProperties = { contentVisibility: "auto", containIntrinsicSize: "auto 160px" }
/** The newest few are never deferred: the reader is usually there, and cards update in place. */
const LIVE_TAIL_SIZE = 8

/**
 * Messages put in the DOM at a time. The store holds a few hundred (the server's first page is
 * 200), but the reader is at the newest almost always: render the tail, and the next batch above
 * only as they scroll toward it — as the chat transcript does with its 10-message pages.
 */
const RENDER_BATCH = 40
/** How close to the top (in viewport heights) the next batch goes in, so it is there before the reader is. */
const REVEAL_AHEAD_VIEWPORTS = 1.5
/** Where the rendered part started when a thread with a `positionKey` unmounted up the thread. */
const savedStartAt = new Map<string, number>()

/** Same as the chat composer (ChatInputArea). */
const ATTACH_ACCEPT =
  "image/*,application/pdf,.txt,.md,.csv,.json,.xml,.yaml,.yml,.html,.css,.js,.ts,.jsx,.tsx,.py,.java,.go,.rs,.c,.cpp,.h,.sh,.sql,.log,.env,.toml,.ini,.cfg"
const ATTACH_MAX_BYTES = 10 * 1024 * 1024

interface AssistantChatProps {
  messages: AssistantMessage[]
  /** The main agent is composing a reply. */
  typing: boolean
  /** The assistant's name from identity.md, for the composer placeholder. */
  assistantName?: string
  /** Older messages exist above the first one shown. */
  hasMore: boolean
  loadingOlder: boolean
  onLoadOlder: () => void
  /** Rejects when the message did not go out; the composer then keeps its attachments. */
  onSend: (text: string, attachments: AssistantAttachment[]) => Promise<void>
  /** Answer an approval card a worker is waiting on. */
  onDecide: (approvalId: string, decision: "allowed_once" | "denied") => void
  onOpenMemory: () => void
  /** Activities by id: a message about a coding agent's conversation shows its card. */
  activities: ActivitySummary[]
  /** Open a coding agent's conversation in its workspace. */
  onOpenChat: (activity: ActivitySummary) => void
  /** The reader came back to the newest message (the store trims what was loaded above). */
  onAtBottom?: () => void
  /** Phone layout: narrower gutters, and the composer rests as a one-line bar. */
  compact?: boolean
  /**
   * The phone keyboard is up. It shrinks the thread from below, which leaves a
   * reader who was at the newest message looking at older ones; toggling it re-pins.
   */
  keyboardOpen?: boolean
  /**
   * Height of chrome floating over the top of the thread (the phone's glass
   * header). The thread scrolls up under it but starts, and stops, below it.
   */
  insetTop?: number
  /** Return to the same reading position when the thread mounts again (the phone's tab switches). */
  positionKey?: string
}

/**
 * The single thread. Only results live here: no tool calls, no progress rows.
 * The process behind a message is one click away in the Activity panel.
 */
export function AssistantChat({
  messages,
  typing,
  assistantName,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onSend,
  onDecide,
  onOpenMemory,
  activities,
  onOpenChat,
  onAtBottom,
  compact = false,
  insetTop,
  positionKey,
}: AssistantChatProps) {
  const intl = useIntl()
  // An approval card is there to be answered; once it is, it leaves the thread (the Audit tab
  // keeps the record). A message that is nothing but an answered card is not shown at all.
  const codingById = useMemo(() => new Map(activities.filter((a) => a.coding).map((a) => [a.id, a])), [activities])
  // An empty message stands for a coding agent's card; with its activity out of reach it shows nothing.
  // Handing the same agent more work puts its card down again at the end: only the latest one shows.
  const shown = useMemo(() => {
    const latestCard = new Map<string, string>()
    for (const m of messages) if (!m.text && !m.approval && m.activityId) latestCard.set(m.activityId, m.id)
    return messages.filter((m) => {
      if (m.approval) return !(m.approval.decision && !m.text)
      if (m.text || m.attachments?.length) return true
      return m.activityId != null && codingById.has(m.activityId) && latestCard.get(m.activityId) === m.id
    })
  }, [messages, codingById])
  const scrollAnchorId = useMemo(() => {
    for (let i = shown.length - 1; i >= 0; i--) {
      if (shown[i].role === "user") return shown[i].id
    }
    return undefined
  }, [shown])
  // Where the rendered part starts: `null` follows the tail (the newest RENDER_BATCH); a time pins
  // the top while the reader is up the thread, so what arrives below shifts nothing above.
  // By time, not id: an answered approval leaves `shown`, and the store trims the oldest.
  // The saved row must be rendered again for the transcript to return to it.
  const [startAt, setStartAt] = useState<number | null>(() => (positionKey ? savedStartAt.get(positionKey) ?? null : null))
  useEffect(() => {
    if (!positionKey) return
    if (startAt == null) savedStartAt.delete(positionKey)
    else savedStartAt.set(positionKey, startAt)
  }, [positionKey, startAt])
  const start = useMemo(() => {
    const tail = Math.max(0, shown.length - RENDER_BATCH)
    if (startAt == null) return tail
    const i = shown.findIndex((m) => m.createdAt >= startAt)
    return i < 0 ? tail : i
  }, [shown, startAt])
  const rendered = start > 0 ? shown.slice(start) : shown
  const revealOlder = useCallback(() => {
    if (start > 0) setStartAt(shown[Math.max(0, start - RENDER_BATCH)].createdAt)
  }, [shown, start])
  const pinStart = useCallback(
    (pinned: boolean) => setStartAt(pinned && shown[start] ? shown[start].createdAt : null),
    [shown, start],
  )
  // Phone: the composer is a one-line bar until it is focused or holds something.
  const [composerFocused, setComposerFocused] = useState(false)
  const [hasText, setHasText] = useState(false)
  const nativeComposer = compact && hasNativeComposer()
  const chatRoot = useRef<HTMLDivElement>(null)
  const composerRoot = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!nativeComposer || !composerRoot.current) return
    const measure = () => chatRoot.current?.style.setProperty('--assistant-composer-height', `${composerRoot.current?.offsetHeight ?? 0}px`)
    const observer = new ResizeObserver(measure)
    observer.observe(composerRoot.current)
    measure()
    return () => observer.disconnect()
  }, [nativeComposer])

  const handleSubmit = ({ text, files }: PromptInputMessage) => {
    // PromptInput has already reset the textarea, which fires no change event.
    setHasText(false)
    const trimmed = text.trim()
    // PromptInput has already uploaded them; a `blob:` left over means even the data-URL fallback failed.
    const attachments = files
      .filter((f) => !f.url.startsWith("blob:"))
      .map((f): AssistantAttachment => ({ url: f.url, mediaType: f.mediaType, ...(f.filename ? { filename: f.filename } : {}) }))
    if (!trimmed && attachments.length === 0) return
    return onSend(trimmed, attachments)
  }

  return (
    <div ref={chatRoot} className="relative flex h-full min-h-0 flex-col">
      <Conversation positionKey={positionKey}>
        <ConversationContent
          scrollClassName="scroll-fade-y"
          className={cn("mx-auto w-full gap-3", compact ? "max-w-3xl px-3 pt-4 pb-4" : "max-w-[calc(48rem+2rem)] px-10 pt-8 pb-10")}
          style={{
            ...(insetTop ? { paddingTop: insetTop + 8 + (compact ? 0 : 16) } : {}),
            ...(nativeComposer ? { paddingBottom: 'calc(var(--assistant-composer-height, 64px) + 16px)' } : {}),
          }}
        >
          {rendered.map((m, j) => {
            const i = start + j
            const prev = shown[i - 1]
            const newDay = !prev || !isSameDay(prev.createdAt, m.createdAt)
            const gap = !newDay && prev != null && m.createdAt - prev.createdAt > TIME_GAP_MS
            return (
              <ConversationItem
                key={m.id}
                messageId={m.id}
                scrollAnchor={m.id === scrollAnchorId}
                className="flex flex-col gap-3"
                style={!compact && i < shown.length - LIVE_TAIL_SIZE ? OFFSCREEN_DEFER_STYLE : undefined}
              >
                {/* Keep the scroller's first direct child a message, so prepending
                    history remains identifiable when the loading hint disappears. */}
                {j === 0 && (hasMore || loadingOlder || start > 0) && (
                  <div className="flex h-6 shrink-0 items-center justify-center text-[11px] text-muted-foreground">
                    {loadingOlder && <FormattedMessage id="assistant.chat.loading" defaultMessage="Loading…" />}
                  </div>
                )}
                {newDay && <Separator label={dayLabel(intl, m.createdAt)} />}
                {gap && <Separator label={formatClock(m.createdAt)} />}
                {m.role === "user" ? (
                  <UserMessage message={m} compact={compact} />
                ) : (
                  <AssistantBubble
                    message={m}
                    coding={m.activityId ? codingById.get(m.activityId) : undefined}
                    onDecide={onDecide}
                    onOpenMemory={onOpenMemory}
                    onOpenChat={onOpenChat}
                    compact={compact}
                  />
                )}
              </ConversationItem>
            )
          })}
          {typing && <ConversationItem><TypingBubble compact={compact} /></ConversationItem>}
        </ConversationContent>
        <ConversationScrollButton style={nativeComposer ? { bottom: 'calc(var(--assistant-composer-height, 64px) + 12px)' } : undefined} />
        <RevealOlderOnScroll
          canReveal={start > 0}
          canLoad={hasMore}
          loadingOlder={loadingOlder}
          onReveal={revealOlder}
          onLoad={onLoadOlder}
          onPinStart={pinStart}
        />
        {onAtBottom && <AtBottom onChange={onAtBottom} />}
      </Conversation>

      <div
        ref={composerRoot}
        className={cn("mx-auto w-full max-w-3xl shrink-0", compact ? "px-2 pb-2" : "px-6 pb-5", nativeComposer && 'absolute inset-x-0 bottom-0')}
        onFocus={() => setComposerFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setComposerFocused(false)
        }}
        // Tapping a composer button must not take focus from the textarea: the
        // blur would collapse the bar under the finger before the click lands.
        onMouseDown={(e) => {
          if (e.target instanceof Element && e.target.closest("button")) e.preventDefault()
        }}
      >
        {nativeComposer ? <NativeAssistantInput
          onSubmit={handleSubmit}
          placeholder={assistantName ? `Message ${assistantName}…` : 'Message…'}
        /> : <PromptInput
          onSubmit={handleSubmit}
          accept={ATTACH_ACCEPT}
          maxFileSize={ATTACH_MAX_BYTES}
          multiple
          className={cn(
            "rounded-xl border border-border/60 bg-popover/90 shadow-input dark:border-border/35 dark:bg-popover/85",
            "[&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-none [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none",
            "[&_[data-slot=input-group]]:focus-within:border-none [&_[data-slot=input-group]]:focus-within:ring-0",
          )}
        >
          <ComposerFields
            canCollapse={compact && !composerFocused && !hasText}
            placeholder={
              assistantName
                ? intl.formatMessage({ id: "assistant.chat.placeholderTo", defaultMessage: "Message {name}…" }, { name: assistantName })
                : intl.formatMessage({ id: "assistant.chat.placeholder", defaultMessage: "Message…" })
            }
            onTextChange={setHasText}
          />
        </PromptInput>}
      </div>
    </div>
  )
}

/** Keep draft updates below the transcript so native typing never re-renders the message list. */
function NativeAssistantInput({ placeholder, onSubmit }: { placeholder: string; onSubmit: (message: PromptInputMessage) => void | Promise<void> }) {
  const [draft, setDraft] = useState('')
  return <PromptInput
    accept={ATTACH_ACCEPT}
    maxFileSize={ATTACH_MAX_BYTES}
    multiple
    onSubmit={async (message) => { await onSubmit(message); setDraft((current) => current === message.text ? '' : current) }}
    className="[&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none"
  >
    <NativePromptComposer value={draft} onChange={setDraft} placeholder={placeholder} />
  </PromptInput>
}

/** Calls `onChange` each time the reader arrives at the newest message. */
function AtBottom({ onChange }: { onChange: () => void }) {
  const { isAtBottom } = useConversationScroll()
  useEffect(() => {
    if (isAtBottom) onChange()
  }, [isAtBottom, onChange])
  return null
}

/**
 * Grows the rendered part upward as the reader nears its top: first the messages already loaded,
 * then the next page from the server. MessageScroller preserves the visible row
 * when those earlier messages are inserted.
 */
function RevealOlderOnScroll({
  canReveal,
  canLoad,
  loadingOlder,
  onReveal,
  onLoad,
  onPinStart,
}: {
  canReveal: boolean
  canLoad: boolean
  loadingOlder: boolean
  onReveal: () => void
  onLoad: () => void
  /** `true` when the reader leaves the newest (hold the top still), `false` back there (follow the tail). */
  onPinStart: (pinned: boolean) => void
}) {
  const { scrollRef, isAtBottom } = useConversationScroll()

  useEffect(() => {
    onPinStart(!isAtBottom)
    // Only on leaving / coming back, not every time the callback changes with the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAtBottom])

  const check = useRef<() => void>(() => {})
  check.current = () => {
    const el = scrollRef.current
    if (!el || el.scrollTop > el.clientHeight * REVEAL_AHEAD_VIEWPORTS) return
    if (canReveal) {
      onReveal()
    } else if (canLoad && !loadingOlder) {
      onLoad()
    }
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => check.current()
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [scrollRef])

  // A server page just came in (hidden above the rendered part): the reader may be sitting at the
  // top with nothing scrolling to ask for it, so look once more. Not on mount: the thread hasn't
  // been scrolled to the newest yet, and scrollTop 0 would read as "at the top".
  const wasLoading = useRef(loadingOlder)
  useEffect(() => {
    if (wasLoading.current && !loadingOlder) check.current()
    wasLoading.current = loadingOlder
  }, [loadingOlder])

  return null
}

/**
 * The composer's inside. Collapsed it is one line with the attach button at
 * its end; otherwise the full box with the toolbar underneath.
 */
function ComposerFields({
  canCollapse,
  placeholder,
  onTextChange,
}: {
  /** Nothing typed and not focused; still stays open while attachments are queued. */
  canCollapse: boolean
  placeholder: string
  onTextChange: (hasText: boolean) => void
}) {
  const attachments = usePromptInputAttachments()
  const collapsed = canCollapse && attachments.files.length === 0
  return (
    <>
      <PromptInputBody>
        <ComposerAttachments />
        <PromptInputTextarea
          placeholder={placeholder}
          // Fixed height too: older WebKit has no field-sizing and would size by rows.
          rows={collapsed ? 1 : undefined}
          className={collapsed ? "h-10 min-h-10 py-2.5" : "min-h-12"}
          onChange={(e) => onTextChange(e.currentTarget.value !== "")}
        />
      </PromptInputBody>
      {collapsed ? (
        <InputGroupAddon align="inline-end" className="py-1">
          <AttachButton />
        </InputGroupAddon>
      ) : (
        <PromptInputFooter>
          <PromptInputTools>
            <AttachButton />
          </PromptInputTools>
          <PromptInputSubmit />
        </PromptInputFooter>
      )}
    </>
  )
}

function AttachButton() {
  const intl = useIntl()
  const attachments = usePromptInputAttachments()
  return (
    <PromptInputButton
      title={intl.formatMessage({ id: "assistant.chat.attach", defaultMessage: "Attach files" })} onClick={() => attachments.openFileDialog()}>
      <PaperclipIcon className="h-4 w-4" />
    </PromptInputButton>
  )
}

/** What is about to be sent, above the textarea. */
function ComposerAttachments() {
  const attachments = usePromptInputAttachments()
  if (attachments.files.length === 0) return null
  return (
    <Attachments className="ml-0 w-full px-3 pt-3">
      {attachments.files.map((file) => (
        <Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
          <AttachmentPreview />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  )
}

/** Attachment cards sit above the text, outside the bubble, as in chats (MessagePartRenderer). */
const UserMessage = memo(function UserMessage({ message, compact }: { message: AssistantMessage; compact: boolean }) {
  const files = message.attachments ?? []
  return (
    <>
      {files.length > 0 && (
        <Message from="user">
          <MessageContent variant="none">
            <Attachments>
              {files.map((file, i) => (
                <Attachment
                  key={`${message.id}-${i}`}
                  data={{ id: `${message.id}-${i}`, type: "file", url: file.url, mediaType: file.mediaType, filename: file.filename }}
                >
                  <AttachmentPreview />
                </Attachment>
              ))}
            </Attachments>
          </MessageContent>
        </Message>
      )}
      {message.text && (
        <Message from="user" className={cn(compact && "max-w-[85%]")}>
          {/* Phone: the brand colour, so the two sides of the thread tell apart at a glance. */}
          <MessageContent
            variant={compact ? "brand" : undefined}
            className={cn(compact && "px-3.5 py-2.5 text-[17px] leading-[1.4]")}
          >
            <span className="whitespace-pre-wrap">{message.text}</span>
          </MessageContent>
        </Message>
      )}
    </>
  )
})

function Separator({ label }: { label: string }) {
  return <div className="py-2 text-center text-[11px] font-medium text-muted-foreground/70">{label}</div>
}

interface AssistantBubbleProps {
  message: AssistantMessage
  /** The coding agent's activity this message is about: its card (no text) or a chip (a reply). */
  coding?: ActivitySummary
  onDecide: (approvalId: string, decision: "allowed_once" | "denied") => void
  onOpenMemory: () => void
  onOpenChat: (activity: ActivitySummary) => void
  compact: boolean
}

/** Memoized: the thread re-renders on every store event (typing, activities); an unchanged reply skips re-parsing its markdown. */
const AssistantBubble = memo(function AssistantBubble({ message, coding, onDecide, onOpenMemory, onOpenChat, compact }: AssistantBubbleProps) {
  const intl = useIntl()
  const { remembered, approval } = message

  return (
    <Message from="assistant" className={cn("gap-1", compact ? "max-w-[92%]" : "max-w-[85%]")}>
      {/* An approval card is a message with nothing to say besides the card. */}
      {message.text && (
        <MessageContent variant="muted" className="px-3.5 py-2.5">
          {/* Phone: 17px at 1.4, the system's own reading size — the desktop's
              0.9rem at prose's loose leading reads small and airy at arm's length. */}
          <MessageResponse className={cn(compact && "text-[17px] leading-[1.4] [&_li]:leading-[1.4] [&_p]:leading-[1.4]")}>
            {messageText(intl, message.text)}
          </MessageResponse>
        </MessageContent>
      )}

      {coding && !message.text && <CodingAgentCard activity={coding} onOpen={onOpenChat} compact={compact} />}
      {coding && message.text && <CodingChip activity={coding} onOpen={onOpenChat} />}

      {/* Only while it waits for an answer; the Audit tab keeps what was decided. */}
      {approval && !approval.decision && (
        <ApprovalCard approval={approval} compact={compact} onDecide={(d) => onDecide(approval.id, d)} />
      )}

      {remembered?.length ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground/80">
          {remembered?.map((fact) => (
            <button
              key={fact}
              type="button"
              onClick={onOpenMemory}
              // One line: the fact in full is a hover (or a tap into memory.md) away.
              className="flex min-w-0 max-w-full items-center gap-1.5 transition-colors hover:text-foreground"
              title={fact}
              aria-label={intl.formatMessage({ id: "assistant.chat.openMemory", defaultMessage: "Open memory.md" })}
            >
              <BookmarkCheck className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                <FormattedMessage id="assistant.chat.remembered" defaultMessage="Remembered: {fact}" values={{ fact }} />
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </Message>
  )
})

/**
 * A tool call waiting on the person, as in the main chat's Confirmation: an Item
 * (icon, what it wants to do, actions), with the raw arguments one click away.
 */
function ApprovalCard({
  approval,
  compact,
  onDecide,
}: {
  approval: AssistantApproval
  compact: boolean
  onDecide: (d: "allowed_once" | "denied") => void
}) {
  const intl = useIntl()
  const [showArgs, setShowArgs] = useState(false)

  return (
    <Item
      variant="outline"
      size="sm"
      className={cn("w-full flex-wrap rounded-xl bg-popover shadow-card", !compact && "min-w-[360px]")}
    >
      <ItemMedia>
        <AuditIconTile icon={approval.icon} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>{approval.title}</ItemTitle>
        <ItemDescription>{auditDetail(intl, approval.detail)}</ItemDescription>
      </ItemContent>
      {showArgs && approval.args && (
        <pre className="code-scrollbar order-last max-h-40 basis-full overflow-auto rounded-lg border border-border/40 bg-background/40 p-3 text-[11px] leading-relaxed text-muted-foreground dark:border-border/35">
          {JSON.stringify(approval.args, null, 2)}
        </pre>
      )}
      <ItemActions className="basis-full flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" className="h-8" onClick={() => onDecide("allowed_once")}>
          <FormattedMessage id="assistant.approval.allowOnce" defaultMessage="Allow once" />
        </Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={() => onDecide("denied")}>
          <FormattedMessage id="assistant.approval.deny" defaultMessage="Deny" />
        </Button>
        {approval.args && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setShowArgs((v) => !v)}
            className="ml-auto text-muted-foreground"
          >
            {showArgs ? (
              <FormattedMessage id="assistant.approval.hideDetails" defaultMessage="Hide details" />
            ) : (
              <FormattedMessage id="assistant.approval.details" defaultMessage="Details" />
            )}
          </Button>
        )}
      </ItemActions>
    </Item>
  )
}

function TypingBubble({ compact }: { compact: boolean }) {
  return (
    <div
      className={cn(
        "flex w-fit items-center gap-1 rounded-xl px-3.5 py-3",
        compact ? "bg-muted" : "bg-muted/50 dark:bg-muted/40",
      )}
    >
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  )
}
