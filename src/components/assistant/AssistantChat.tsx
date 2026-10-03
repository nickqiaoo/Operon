import { Fragment, useState } from "react"
import { BookmarkCheck, CalendarClock, HeartPulse, Mic, Plus } from "lucide-react"
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
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AssistantMessage, AuditDecision, PendingApproval } from "./types"
import { AuditIconTile, DECISION_LABEL, dayLabel, formatClock, isSameDay } from "./shared"

/** Messages further apart than this get a time label between them (same day). */
const TIME_GAP_MS = 30 * 60_000

interface AssistantChatProps {
  messages: AssistantMessage[]
  /** The main agent is composing a reply. */
  typing: boolean
  userName?: string
  highlightedActivityId: string | null
  onSend: (text: string) => void
  onOpenActivity: (activityId: string) => void
  onDecide: (messageId: string, decision: AuditDecision) => void
  onOpenMemory: () => void
}

/**
 * The single thread. Only results live here: no tool calls, no progress rows.
 * The process behind a message is one click away in the Activity panel.
 */
export function AssistantChat({
  messages,
  typing,
  userName,
  highlightedActivityId,
  onSend,
  onOpenActivity,
  onDecide,
  onOpenMemory,
}: AssistantChatProps) {
  const handleSubmit = ({ text }: PromptInputMessage) => {
    const trimmed = text.trim()
    if (trimmed) onSend(trimmed)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Conversation initial="instant">
        <ConversationContent scrollClassName="scroll-fade-y">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 pb-6 pt-4">
            {messages.map((m, i) => {
              const prev = messages[i - 1]
              const newDay = !prev || !isSameDay(prev.createdAt, m.createdAt)
              const gap = !newDay && prev != null && m.createdAt - prev.createdAt > TIME_GAP_MS
              return (
                <Fragment key={m.id}>
                  {newDay && <Separator label={dayLabel(m.createdAt)} />}
                  {gap && <Separator label={formatClock(m.createdAt)} />}
                  {m.role === "user" ? (
                    <Message from="user">
                      <MessageContent>
                        <span className="whitespace-pre-wrap">{m.text}</span>
                      </MessageContent>
                    </Message>
                  ) : (
                    <AssistantBubble
                      message={m}
                      highlighted={m.activityId != null && m.activityId === highlightedActivityId}
                      onOpenActivity={onOpenActivity}
                      onDecide={onDecide}
                      onOpenMemory={onOpenMemory}
                    />
                  )}
                </Fragment>
              )
            })}
            {typing && <TypingBubble />}
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-5">
        <PromptInput
          onSubmit={handleSubmit}
          className={cn(
            "rounded-xl border border-border/60 bg-popover/90 shadow-input dark:border-border/35 dark:bg-popover/85",
            "[&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-none [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none",
            "[&_[data-slot=input-group]]:focus-within:border-none [&_[data-slot=input-group]]:focus-within:ring-0",
          )}
        >
          <PromptInputBody>
            <PromptInputTextarea placeholder={userName ? `Message, ${userName}…` : "Message…"} className="min-h-12" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputButton title="Attach">
                <Plus className="h-4 w-4" />
              </PromptInputButton>
            </PromptInputTools>
            <div className="flex items-center gap-1">
              <PromptInputButton title="Voice">
                <Mic className="h-4 w-4" />
              </PromptInputButton>
              <PromptInputSubmit />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

function Separator({ label }: { label: string }) {
  return <div className="py-2 text-center text-[11px] font-medium text-muted-foreground/70">{label}</div>
}

interface AssistantBubbleProps {
  message: AssistantMessage
  highlighted: boolean
  onOpenActivity: (activityId: string) => void
  onDecide: (messageId: string, decision: AuditDecision) => void
  onOpenMemory: () => void
}

function AssistantBubble({ message, highlighted, onOpenActivity, onDecide, onOpenMemory }: AssistantBubbleProps) {
  const { trigger, activityId, remembered, approval } = message
  const proactive = trigger?.kind === "heartbeat" || trigger?.kind === "schedule"

  return (
    <Message from="assistant" className="max-w-[85%] gap-1">
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

      <MessageContent
        className={cn(
          "rounded-xl bg-muted/50 px-3.5 py-2.5 transition-shadow dark:bg-muted/40",
          highlighted && "ring-1 ring-border",
        )}
      >
        <MessageResponse>{message.text}</MessageResponse>
      </MessageContent>

      {approval && <ApprovalCard approval={approval} onDecide={(d) => onDecide(message.id, d)} />}

      {(remembered?.length || activityId) && (
        <div className="flex items-center gap-3 px-1 text-[11px] text-muted-foreground/80">
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
              className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
            >
              View activity
            </button>
          )}
        </div>
      )}
    </Message>
  )
}

function ApprovalCard({ approval, onDecide }: { approval: PendingApproval; onDecide: (d: AuditDecision) => void }) {
  const [showArgs, setShowArgs] = useState(false)

  if (approval.decision) {
    return (
      <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground/80">
        <span>{approval.title}</span>
        <span className="text-muted-foreground/50">·</span>
        <span className={approval.decision === "denied" ? "text-status-error" : "text-status-ok"}>
          {DECISION_LABEL[approval.decision]}
        </span>
      </div>
    )
  }

  return (
    <div className="w-full min-w-[360px] space-y-3 rounded-xl border border-border/60 bg-popover p-4 shadow-card dark:border-border/35">
      <div className="flex items-start gap-3">
        <AuditIconTile icon={approval.icon} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{approval.title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{approval.intent}</div>
        </div>
      </div>
      {showArgs && (
        <pre className="max-h-40 overflow-auto rounded-lg border border-border/40 bg-background/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
          {JSON.stringify(approval.args, null, 2)}
        </pre>
      )}
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="secondary" className="h-8" onClick={() => onDecide("allowed_once")}>
          Allow once
        </Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={() => onDecide("always_allowed")}>
          Always allow
        </Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={() => onDecide("denied")}>
          Deny
        </Button>
        <button
          type="button"
          onClick={() => setShowArgs((v) => !v)}
          className="ml-auto text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {showArgs ? "Hide details" : "Details"}
        </button>
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
