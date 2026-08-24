import { useEffect, useState } from "react"
import {
  Check,
  CircleAlert,
  ExternalLink,
  Inbox as InboxIcon,
  Loader2,
  MessageSquare,
  X,
} from "lucide-react"
import type { UIMessage } from "ai"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"
import { StatusIcon, LabelChip, relativeTime } from "@/components/task/task-meta"
import {
  AskUserQuestionRenderer,
  type ToolInvocationPart,
} from "@/components/editor/components/AskUserQuestionRenderer"
import type { Notification } from "@/types/notification"
import type { TaskDetail } from "@/types/task"
import { cn } from "@/lib/utils"

interface InboxDetailProps {
  notification: Notification | null
  /** Deep-link to the live source (task board / workspace chat). */
  onOpenSource: (n: Notification) => void
}

/** The right-hand detail pane: task detail, chat summary, or an empty state. */
export function InboxDetail({ notification, onOpenSource }: InboxDetailProps) {
  if (!notification) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <InboxIcon className="size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">Select a notification to see the details</p>
      </div>
    )
  }
  if (notification.taskId != null) {
    return <TaskDetailPane key={notification.id} notification={notification} onOpenSource={onOpenSource} />
  }
  return <ChatDetailPane key={notification.id} notification={notification} onOpenSource={onOpenSource} />
}

function DetailHeader({
  title,
  onOpen,
  openLabel,
}: {
  title: string
  onOpen: () => void
  openLabel: string
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/40 px-6 py-3">
      <span className="truncate text-sm font-medium text-foreground/90">{title}</span>
      <Button size="sm" variant="secondary" className="h-8 shrink-0 gap-1.5" onClick={onOpen}>
        <ExternalLink className="h-3.5 w-3.5" /> {openLabel}
      </Button>
    </div>
  )
}

function TaskDetailPane({
  notification,
  onOpenSource,
}: {
  notification: Notification
  onOpenSource: (n: Notification) => void
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .taskGet(notification.taskId!)
      .then(({ task }) => {
        if (!cancelled) {
          setDetail(task)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [notification.taskId])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailHeader
        title={detail ? `#${detail.number}` : notification.title}
        onOpen={() => onOpenSource(notification)}
        openLabel="Open in board"
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-2xl">
          {loading && !detail ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !detail ? (
            <p className="text-sm text-muted-foreground">This task is no longer available.</p>
          ) : (
            <>
              <h1 className="text-xl font-semibold text-foreground">{detail.title}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <StatusIcon status={detail.status} />
                  <span className="capitalize">{detail.status.replace("_", " ")}</span>
                </span>
                {detail.labels.map((l) => (
                  <LabelChip key={l.id} label={l} />
                ))}
              </div>

              {detail.description?.trim() && (
                <div className="mt-5 text-sm">
                  <MarkdownRenderer content={detail.description} />
                </div>
              )}

              {detail.activity.length > 0 && (
                <div className="mt-8">
                  <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                    Activity
                  </div>
                  <ol className="space-y-3 border-l border-border/40 pl-4">
                    {detail.activity.map((a) => (
                      <li key={a.id} className="relative text-sm">
                        <span className="absolute -left-[21px] top-1.5 size-1.5 rounded-full bg-border" />
                        <div className="flex items-baseline gap-2">
                          <span className="font-medium text-foreground/80">{a.actorName}</span>
                          <span className="text-[11px] text-muted-foreground/60">
                            {relativeTime(a.createdAt)}
                          </span>
                        </div>
                        {a.body && (
                          <div className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{a.body}</div>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface PendingApproval {
  approvalId: string
  toolName: string
  requestedAt: number
  /** Set when a detached workflow sub-agent asked, not this chat's own turn. */
  origin?: string
  /** The asking tool's input (AskUserQuestion questions), sub-agents only. */
  toolInput?: unknown
}

/** Tool inputs cross the wire as `unknown`; the renderer needs a plain object. */
function asToolInput(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * A question from a detached workflow sub-agent, answered here in the inbox.
 *
 * A normal chat renders this form from the tool-call part in its own message
 * stream. A sub-agent has no chat page to open, so the question payload travels
 * with the pending approval instead and the same renderer is fed a synthetic
 * tool part built from it — one form, one answer format, both places.
 */
function SubAgentQuestion({
  approval,
  busy,
  onDecide,
}: {
  approval: PendingApproval
  busy: boolean
  onDecide: (id: string, outcome: "allow" | "deny", updatedInput?: Record<string, unknown>) => void
}) {
  const toolPart: ToolInvocationPart = {
    type: "dynamic-tool",
    toolName: "AskUserQuestion",
    toolCallId: approval.approvalId,
    input: asToolInput(approval.toolInput),
    state: "approval-requested",
    approval: { id: approval.approvalId },
  }
  return (
    <div className="rounded-lg border border-border/40 bg-background/40 p-3">
      {approval.origin ? (
        <div className="mb-2 text-xs text-muted-foreground">
          Asked by sub-agent <span className="font-mono">{approval.origin}</span>
        </div>
      ) : null}
      <div className={cn(busy && "pointer-events-none opacity-60")}>
        <AskUserQuestionRenderer
          toolPart={toolPart}
          messageId={`inbox-${approval.approvalId}`}
          partIndex={0}
          onPermissionDecide={(id, outcome, updatedInput) =>
            onDecide(id, outcome === "deny" ? "deny" : "allow", updatedInput)
          }
        />
      </div>
    </div>
  )
}

/** Text content of a UIMessage — its text parts, joined. */
function messageText(message: UIMessage | undefined): string {
  if (!message) return ""
  const parts = (message.parts ?? []) as Array<{ type?: string; text?: unknown }>
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n\n")
    .trim()
}

function ChatDetailPane({
  notification,
  onOpenSource,
}: {
  notification: Notification
  onOpenSource: (n: Notification) => void
}) {
  const chatId = notification.chatId
  const [loading, setLoading] = useState(true)
  const [promptText, setPromptText] = useState("")
  const [replyText, setReplyText] = useState("")
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (chatId == null) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void Promise.allSettled([
      api.chatHistoryGet(chatId, { limit: 30 }),
      api.aiPendingApprovals(chatId),
    ]).then(([history, pending]) => {
      if (cancelled) return
      if (history.status === "fulfilled") {
        const messages = (history.value.messages ?? []) as UIMessage[]
        let reply = ""
        let prompt = ""
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const m = messages[i]
          if (!reply && m.role === "assistant") reply = messageText(m)
          if (!prompt && m.role === "user") prompt = messageText(m)
          if (reply && prompt) break
        }
        setReplyText(reply)
        setPromptText(prompt)
      }
      if (pending.status === "fulfilled") setApprovals(pending.value.approvals ?? [])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [chatId, notification.id])

  const decide = async (
    approvalId: string,
    outcome: "allow" | "deny",
    // Answers to an AskUserQuestion ride the same round-trip as a plain approval.
    updatedInput?: Record<string, unknown>,
  ) => {
    if (chatId == null) return
    setBusyId(approvalId)
    try {
      const res = await api.aiPermissionResponse({
        id: approvalId,
        outcome: updatedInput ? { outcome, updatedInput } : outcome,
        chatId,
      })
      if (res.success) {
        setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId))
      } else {
        // Stale entry (e.g. the approval timed out) — resync with the server.
        const fresh = await api.aiPendingApprovals(chatId)
        setApprovals(fresh.approvals ?? [])
      }
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailHeader
        title={notification.title}
        onOpen={() => onOpenSource(notification)}
        openLabel="Open conversation"
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className={cn("mx-auto flex max-w-2xl flex-col gap-5")}>
          <div className="flex items-center gap-2 text-muted-foreground">
            <MessageSquare className="size-4" />
            <span className="text-sm">Workspace conversation</span>
          </div>
          <h1 className="text-xl font-semibold text-foreground">{notification.title}</h1>

          {approvals.length > 0 && (
            <div className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                <CircleAlert className="h-4 w-4 shrink-0" /> The agent is waiting on you
              </div>
              {approvals.map((a) =>
                // A sub-agent's question ships its own `questions` payload, because
                // its stream is not on screen anywhere for the form to read from.
                // Answer it right here — "open the conversation" would lead nowhere.
                a.toolName === "AskUserQuestion" && a.toolInput ? (
                  <SubAgentQuestion
                    key={a.approvalId}
                    approval={a}
                    busy={busyId === a.approvalId}
                    onDecide={decide}
                  />
                ) : a.toolName === "AskUserQuestion" ||
                  a.toolName === "ExitPlanMode" ||
                  a.approvalId.startsWith("plan-approval-") ? (
                  <div key={a.approvalId} className="text-sm text-muted-foreground">
                    {a.toolName === "AskUserQuestion"
                      ? "The agent asked you a question — open the conversation to answer."
                      : "The agent proposed a plan — open the conversation to review it."}
                  </div>
                ) : (
                  // Tool name on its own row, actions below. Side-by-side with
                  // flex-wrap made the layout depend on name length — short names
                  // kept the buttons inline, long ones pushed them to a second
                  // row, so no two cards looked alike.
                  <div
                    key={a.approvalId}
                    className="rounded-lg border border-border/40 bg-background/40 px-3 py-2.5"
                  >
                    <div className="text-sm break-words">
                      Approval requested ·{" "}
                      <span className="font-mono text-xs text-muted-foreground">{a.toolName}</span>
                    </div>
                    {/* This conversation launched a workflow and is otherwise idle,
                        so say which sub-agent is blocked — without it the request
                        reads as if the chat itself were stuck. */}
                    {a.origin ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        Requested by sub-agent{" "}
                        <span className="font-mono">{a.origin}</span>
                      </div>
                    ) : null}
                    {/* Both buttons share size/height/shape — only the semantic
                        colour differs, so approve and deny read as one pair of
                        equal choices rather than a primary and an afterthought. */}
                    <div className="mt-2.5 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        // `approve`/`deny` are label-contrast tokens; they already
                        // carry their own light and dark values, so this needs no
                        // `dark:` variant. See --color-status-ok in globals.css for
                        // why --color-accent-green can't be used as text here.
                        className={cn(
                          "h-8 gap-1.5 border-status-ok/25 bg-status-ok/10 text-status-ok shadow-none",
                          "hover:border-status-ok/45 hover:bg-status-ok/20 hover:text-status-ok",
                        )}
                        disabled={busyId === a.approvalId}
                        onClick={() => void decide(a.approvalId, "allow")}
                      >
                        {busyId === a.approvalId ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className={cn(
                          "h-8 gap-1.5 border-status-error/25 bg-status-error/10 text-status-error shadow-none",
                          "hover:border-status-error/45 hover:bg-status-error/20 hover:text-status-error",
                        )}
                        disabled={busyId === a.approvalId}
                        onClick={() => void decide(a.approvalId, "deny")}
                      >
                        <X className="h-3.5 w-3.5" /> Deny
                      </Button>
                    </div>
                  </div>
                ),
              )}
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : replyText ? (
            <div className="space-y-3">
              {promptText && (
                <div className="whitespace-pre-wrap rounded-lg border border-border/40 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
                  {promptText.length > 400 ? `${promptText.slice(0, 400)}…` : promptText}
                </div>
              )}
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                  Latest reply
                </div>
                <div className="text-sm">
                  <MarkdownRenderer content={replyText} />
                </div>
              </div>
            </div>
          ) : (
            notification.body && (
              <p className="text-sm text-muted-foreground">{notification.body}</p>
            )
          )}
        </div>
      </div>
    </div>
  )
}
