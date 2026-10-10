import { Fragment, useEffect, useRef, useState } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { BookmarkCheck, CalendarClock, HeartPulse, PaperclipIcon } from "lucide-react"
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
import type { ApprovalDecision, AssistantApproval, AssistantAttachment, AssistantMessage } from "./types"
import { AuditIconTile, DECISION_LABEL, dayLabel, formatClock, isSameDay } from "./shared"

/** Messages further apart than this get a time label between them (same day). */
const TIME_GAP_MS = 30 * 60_000

/** Same as the chat composer (ChatInputArea). */
const ATTACH_ACCEPT =
  "image/*,application/pdf,.txt,.md,.csv,.json,.xml,.yaml,.yml,.html,.css,.js,.ts,.jsx,.tsx,.py,.java,.go,.rs,.c,.cpp,.h,.sh,.sql,.log,.env,.toml,.ini,.cfg"
const ATTACH_MAX_BYTES = 10 * 1024 * 1024

interface AssistantChatProps {
  messages: AssistantMessage[]
  /** The main agent is composing a reply. */
  typing: boolean
  userName?: string
  /** Older messages exist above the first one shown. */
  hasMore: boolean
  loadingOlder: boolean
  onLoadOlder: () => void
  highlightedActivityId: string | null
  /** Rejects when the message did not go out; the composer then keeps its attachments. */
  onSend: (text: string, attachments: AssistantAttachment[]) => Promise<void>
  onOpenActivity: (activityId: string) => void
  /** Answer an approval card a worker is waiting on. */
  onDecide: (approvalId: string, decision: Exclude<ApprovalDecision, "expired">) => void
  onOpenMemory: () => void
  /** Phone layout: narrower gutters, and the composer rests as a one-line bar. */
  compact?: boolean
  /**
   * The phone keyboard is up. It shrinks the thread from below, which leaves a
   * reader who was at the newest message looking at older ones; toggling it re-pins.
   */
  keyboardOpen?: boolean
}

/**
 * The single thread. Only results live here: no tool calls, no progress rows.
 * The process behind a message is one click away in the Activity panel.
 */
export function AssistantChat({
  messages,
  typing,
  userName,
  hasMore,
  loadingOlder,
  onLoadOlder,
  highlightedActivityId,
  onSend,
  onOpenActivity,
  onDecide,
  onOpenMemory,
  compact = false,
  keyboardOpen = false,
}: AssistantChatProps) {
  // Phone: the composer is a one-line bar until it is focused or holds something.
  const [composerFocused, setComposerFocused] = useState(false)
  const [hasText, setHasText] = useState(false)

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
    <div className="flex h-full min-h-0 flex-col">
      <Conversation initial="instant">
        <ConversationContent scrollClassName="scroll-fade-y">
          <div className={cn("mx-auto flex w-full max-w-3xl flex-col gap-3 pt-4", compact ? "px-2 pb-4" : "px-6 pb-6")}>
            {hasMore && (
              <button
                type="button"
                onClick={onLoadOlder}
                disabled={loadingOlder}
                className="mx-auto rounded-lg px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground disabled:opacity-60"
              >
                {loadingOlder ? "Loading…" : "Load earlier messages"}
              </button>
            )}
            {messages.map((m, i) => {
              const prev = messages[i - 1]
              const newDay = !prev || !isSameDay(prev.createdAt, m.createdAt)
              const gap = !newDay && prev != null && m.createdAt - prev.createdAt > TIME_GAP_MS
              return (
                <Fragment key={m.id}>
                  {newDay && <Separator label={dayLabel(m.createdAt)} />}
                  {gap && <Separator label={formatClock(m.createdAt)} />}
                  {m.role === "user" ? (
                    <UserMessage message={m} />
                  ) : (
                    <AssistantBubble
                      message={m}
                      highlighted={m.activityId != null && m.activityId === highlightedActivityId}
                      onOpenActivity={onOpenActivity}
                      onDecide={onDecide}
                      onOpenMemory={onOpenMemory}
                      compact={compact}
                    />
                  )}
                </Fragment>
              )
            })}
            {typing && <TypingBubble />}
          </div>
        </ConversationContent>
        <ConversationScrollButton />
        <RepinOnChange value={keyboardOpen} />
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
            placeholder={userName ? `Message, ${userName}…` : "Message…"}
            onTextChange={setHasText}
          />
        </PromptInput>
      </div>
    </div>
  )
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
  const attachments = usePromptInputAttachments()
  return (
    <PromptInputButton title="Attach files" onClick={() => attachments.openFileDialog()}>
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
function UserMessage({ message }: { message: AssistantMessage }) {
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
        <Message from="user">
          <MessageContent>
            <span className="whitespace-pre-wrap">{message.text}</span>
          </MessageContent>
        </Message>
      )}
    </>
  )
}

function Separator({ label }: { label: string }) {
  return <div className="py-2 text-center text-[11px] font-medium text-muted-foreground/70">{label}</div>
}

interface AssistantBubbleProps {
  message: AssistantMessage
  highlighted: boolean
  onOpenActivity: (activityId: string) => void
  onDecide: (approvalId: string, decision: Exclude<ApprovalDecision, "expired">) => void
  onOpenMemory: () => void
  compact: boolean
}

function AssistantBubble({ message, highlighted, onOpenActivity, onDecide, onOpenMemory, compact }: AssistantBubbleProps) {
  const { trigger, activityId, remembered, approval } = message
  const proactive = trigger?.kind === "heartbeat" || trigger?.kind === "schedule"

  return (
    <Message from="assistant" className={cn("gap-1", compact ? "max-w-[92%]" : "max-w-[85%]")}>
      {proactive && (
        <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground/80">
          {trigger.kind === "heartbeat" ? (
            <>
              <HeartPulse className="h-3 w-3" /> Heartbeat
            </>
          ) : (
            <>
              <CalendarClock className="h-3 w-3" /> {trigger.name}
            </>
          )}
        </div>
      )}

      {/* An approval card is a message with nothing to say besides the card. */}
      {message.text && (
        <MessageContent
          className={cn(
            "rounded-xl bg-muted/50 px-3.5 py-2.5 transition-shadow dark:bg-muted/40",
            highlighted && "ring-1 ring-border",
          )}
        >
          <MessageResponse>{message.text}</MessageResponse>
        </MessageContent>
      )}

      {approval && <ApprovalCard approval={approval} compact={compact} onDecide={(d) => onDecide(approval.id, d)} />}

      {(remembered?.length || activityId) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground/80">
          {remembered?.map((fact) => (
            <button
              key={fact}
              type="button"
              onClick={onOpenMemory}
              className="flex items-center gap-1 transition-colors hover:text-foreground"
              title="Open memory.md"
            >
              <BookmarkCheck className="h-3 w-3" />
              Remembered: {fact}
            </button>
          ))}
          {activityId && (
            <button
              type="button"
              onClick={() => onOpenActivity(activityId)}
              className={cn(
                "transition-opacity hover:text-foreground",
                // Revealed on hover on desktop; a phone has no hover, so it just shows.
                !compact && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
            >
              View activity
            </button>
          )}
        </div>
      )}
    </Message>
  )
}

function ApprovalCard({
  approval,
  compact,
  onDecide,
}: {
  approval: AssistantApproval
  compact: boolean
  onDecide: (d: Exclude<ApprovalDecision, "expired">) => void
}) {
  const [showArgs, setShowArgs] = useState(false)

  if (approval.decision) {
    return (
      <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground/80">
        <span>{approval.title}</span>
        <span className="text-muted-foreground/50">·</span>
        <span
          className={
            approval.decision === "denied" ? "text-status-error" : approval.decision === "expired" ? "text-muted-foreground" : "text-status-ok"
          }
        >
          {DECISION_LABEL[approval.decision]}
        </span>
      </div>
    )
  }

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
          <div className="mt-0.5 text-xs text-muted-foreground">{approval.detail}</div>
        </div>
      </div>
      {showArgs && approval.args && (
        <pre className="max-h-40 overflow-auto rounded-lg border border-border/40 bg-background/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
          {JSON.stringify(approval.args, null, 2)}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="secondary" className="h-8" onClick={() => onDecide("allowed_once")}>
          Allow once
        </Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={() => onDecide("always_allowed")}>
          Always allow
        </Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={() => onDecide("denied")}>
          Deny
        </Button>
        {approval.args && (
          <button
            type="button"
            onClick={() => setShowArgs((v) => !v)}
            className="ml-auto text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {showArgs ? "Hide details" : "Details"}
          </button>
        )}
      </div>
    </div>
  )
}

function TypingBubble() {
  return (
    <div className="flex w-fit items-center gap-1 rounded-xl bg-muted/50 px-3.5 py-3 dark:bg-muted/40">
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
