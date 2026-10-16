import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom"
import { BookmarkCheck, PaperclipIcon } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { Attachment, AttachmentPreview, AttachmentRemove, Attachments } from "@/components/ai-elements/attachments"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation"
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
import { InputGroupAddon } from "@/components/ui/input-group"
import { cn } from "@/lib/utils"
import type { ActivitySummary, AssistantApproval, AssistantAttachment, AssistantMessage } from "./types"
import { CodingAgentCard, CodingChip } from "./CodingAgentCard"
import { AuditIconTile, formatClock, isSameDay } from "./shared"
import { auditDetail, dayLabel, messageText } from "./assistant-i18n"

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
  keyboardOpen = false,
  insetTop,
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
  // Where the rendered part starts: `null` follows the tail (the newest RENDER_BATCH); a time pins
  // the top while the reader is up the thread, so what arrives below shifts nothing above.
  // By time, not id: an answered approval leaves `shown`, and the store trims the oldest.
  const [startAt, setStartAt] = useState<number | null>(null)
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
  const scroller = useRef<StickToBottomContext>(null)

  const handleSubmit = ({ text, files }: PromptInputMessage) => {
    // PromptInput has already reset the textarea, which fires no change event.
    setHasText(false)
    const trimmed = text.trim()
    // PromptInput has already uploaded them; a `blob:` left over means even the data-URL fallback failed.
    const attachments = files
      .filter((f) => !f.url.startsWith("blob:"))
      .map((f): AssistantAttachment => ({ url: f.url, mediaType: f.mediaType, ...(f.filename ? { filename: f.filename } : {}) }))
    if (!trimmed && attachments.length === 0) return
    const sent = onSend(trimmed, attachments)
    // What the user just said goes to the bottom of the thread, and so do they — even from up
    // the thread, where the scroller has let go of the bottom and would leave it out of sight.
    void scroller.current?.scrollToBottom("smooth")
    return sent
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Conversation initial="instant" contextRef={scroller}>
        {/* Phone: the content's own p-4 would stack on the gutter (24px a side); drop it so
            the bubbles get the width. */}
        <ConversationContent scrollClassName="scroll-fade-y" className={cn(compact && "p-0")}>
          <div
            className={cn("mx-auto flex w-full max-w-3xl flex-col gap-3 pt-4", compact ? "px-3 pb-4" : "px-6 pb-6")}
            style={insetTop ? { paddingTop: insetTop + 8 } : undefined}
          >
            {/* Held open while anything is left above, so "Loading…" coming and going doesn't
                push the thread around; it leaves in the same commit as the last batch, which
                the scroll make-up already counts. */}
            {(hasMore || loadingOlder || start > 0) && (
              <div className="flex h-6 shrink-0 items-center justify-center text-[11px] text-muted-foreground">
                {loadingOlder && <FormattedMessage id="assistant.chat.loading" defaultMessage="Loading…" />}
              </div>
            )}
            {rendered.map((m, j) => {
              const i = start + j
              const prev = shown[i - 1]
              const newDay = !prev || !isSameDay(prev.createdAt, m.createdAt)
              const gap = !newDay && prev != null && m.createdAt - prev.createdAt > TIME_GAP_MS
              return (
                <div
                  key={m.id}
                  className="flex flex-col gap-3"
                  style={!compact && i < shown.length - LIVE_TAIL_SIZE ? OFFSCREEN_DEFER_STYLE : undefined}
                >
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
                </div>
              )
            })}
            {typing && <TypingBubble compact={compact} />}
          </div>
        </ConversationContent>
        <ConversationScrollButton />
        <RepinOnChange value={keyboardOpen} />
        <EscapeOnTouchScroll />
        <RevealOlderOnScroll
          start={start}
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
        className={cn("mx-auto w-full max-w-3xl shrink-0", compact ? "px-2 pb-2" : "px-6 pb-5")}
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
        <PromptInput
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
        </PromptInput>
      </div>
    </div>
  )
}

/** Calls `onChange` each time the reader arrives at the newest message. */
function AtBottom({ onChange }: { onChange: () => void }) {
  const { isAtBottom } = useStickToBottomContext()
  useEffect(() => {
    if (isAtBottom) onChange()
  }, [isAtBottom, onChange])
  return null
}

/**
 * Lets go of the bottom as soon as a finger drags the thread toward older messages. The
 * scroller does this for a mouse wheel, but a touch has no wheel event: it only notices from
 * scroll events, and skips those while the content is resizing (a reply streaming in), so it
 * keeps pulling back to the bottom against the swipe.
 */
function EscapeOnTouchScroll() {
  const { scrollRef, state, stopScroll } = useStickToBottomContext()
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let lastY: number | null = null
    const onStart = (e: TouchEvent) => {
      lastY = e.touches[0]?.clientY ?? null
    }
    const onMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY
      if (y == null || lastY == null) return
      // Finger moving down = content scrolling up, toward older messages.
      if (y > lastY && state.isAtBottom && el.scrollHeight > el.clientHeight) stopScroll()
      lastY = y
    }
    el.addEventListener("touchstart", onStart, { passive: true })
    el.addEventListener("touchmove", onMove, { passive: true })
    return () => {
      el.removeEventListener("touchstart", onStart)
      el.removeEventListener("touchmove", onMove)
    }
  }, [scrollRef, state, stopScroll])
  return null
}

/**
 * Grows the rendered part upward as the reader nears its top: first the messages already loaded,
 * then the next page from the server. What goes in above is made up for in scrollTop before the
 * frame is painted, so what the reader is looking at doesn't move.
 */
function RevealOlderOnScroll({
  start,
  canReveal,
  canLoad,
  loadingOlder,
  onReveal,
  onLoad,
  onPinStart,
}: {
  /** Index of the first rendered message; changes when a batch goes in. */
  start: number
  canReveal: boolean
  canLoad: boolean
  loadingOlder: boolean
  onReveal: () => void
  onLoad: () => void
  /** `true` when the reader leaves the newest (hold the top still), `false` back there (follow the tail). */
  onPinStart: (pinned: boolean) => void
}) {
  const { scrollRef, isAtBottom } = useStickToBottomContext()
  const before = useRef<{ height: number; top: number } | null>(null)

  useEffect(() => {
    onPinStart(!isAtBottom)
    // Only on leaving / coming back, not every time the callback changes with the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAtBottom])

  // Same commit as the new batch: the browser has laid it out but not painted it.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const prev = before.current
    before.current = null
    if (!el || !prev) return
    const added = el.scrollHeight - prev.height
    if (added > 0) el.scrollTop = prev.top + added
  }, [start, scrollRef])

  const check = useRef<() => void>(() => {})
  check.current = () => {
    const el = scrollRef.current
    if (!el || before.current || el.scrollTop > el.clientHeight * REVEAL_AHEAD_VIEWPORTS) return
    if (canReveal) {
      before.current = { height: el.scrollHeight, top: el.scrollTop }
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

/** Scroll back to the newest message when `value` changes, if that is where the reader was. */
function RepinOnChange({ value }: { value: unknown }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  // The value from before the change: by the time the effect runs the view has already shrunk.
  const wasAtBottom = useRef(isAtBottom)
  useEffect(() => {
    if (!wasAtBottom.current) return
    // Next frame: the layout has to settle at the new height first.
    const frame = requestAnimationFrame(() => void scrollToBottom("instant"))
    return () => cancelAnimationFrame(frame)
  }, [value, scrollToBottom])
  useEffect(() => {
    wasAtBottom.current = isAtBottom
  }, [isAtBottom])
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
    <Attachments className="ml-0 w-full px-3 pt-3" variant="grid">
      {attachments.files.map((file) => (
        <Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
          <AttachmentPreview />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  )
}

/** Attachments sit above the text in a bubble of their own, as in chats (MessagePartRenderer). */
const UserMessage = memo(function UserMessage({ message, compact }: { message: AssistantMessage; compact: boolean }) {
  const files = message.attachments ?? []
  return (
    <>
      {files.length > 0 && (
        <Message from="user">
          <MessageContent>
            <Attachments variant="grid">
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
            className={cn(
              compact &&
                "text-[17px] leading-[1.4] group-[.is-user]:bg-brand-fill group-[.is-user]:px-3.5 group-[.is-user]:py-2.5 group-[.is-user]:text-brand-fg group-[.is-user]:shadow-none",
            )}
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
        <MessageContent
          className={cn(
            "rounded-xl px-3.5 py-2.5 transition-shadow",
            // Phone: a solid surface so the reply reads as a bubble against the canvas.
            compact ? "bg-muted" : "bg-muted/50 dark:bg-muted/40",
          )}
        >
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
    <div
      className={cn(
        "w-full space-y-3 rounded-xl border border-border/60 bg-popover p-4 shadow-card dark:border-border/35",
        !compact && "min-w-[360px]",
      )}
    >
      <div className="flex items-start gap-3">
        <AuditIconTile icon={approval.icon} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{approval.title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{auditDetail(intl, approval.detail)}</div>
        </div>
      </div>
      {showArgs && approval.args && (
        <pre className="max-h-40 overflow-auto rounded-lg border border-border/40 bg-background/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
          {JSON.stringify(approval.args, null, 2)}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="secondary" className="h-8" onClick={() => onDecide("allowed_once")}>
          <FormattedMessage id="assistant.approval.allowOnce" defaultMessage="Allow once" />
        </Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={() => onDecide("denied")}>
          <FormattedMessage id="assistant.approval.deny" defaultMessage="Deny" />
        </Button>
        {approval.args && (
          <button
            type="button"
            onClick={() => setShowArgs((v) => !v)}
            className="ml-auto text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {showArgs ? (
              <FormattedMessage id="assistant.approval.hideDetails" defaultMessage="Hide details" />
            ) : (
              <FormattedMessage id="assistant.approval.details" defaultMessage="Details" />
            )}
          </button>
        )}
      </div>
    </div>
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
