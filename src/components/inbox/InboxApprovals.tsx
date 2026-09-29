import { useEffect, useState } from "react"
import { Check, Loader2, MessageCircleQuestion, X } from "lucide-react"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  AskUserQuestionRenderer,
  type ToolInvocationPart,
} from "@/components/editor/components/AskUserQuestionRenderer"
import { cn } from "@/lib/utils"

interface PendingApproval {
  approvalId: string
  toolName: string
  requestedAt: number
  /** Set when a detached workflow sub-agent asked, not this chat's own turn. */
  origin?: string
  /** The asking tool's input (AskUserQuestion questions), sub-agents only. */
  toolInput?: unknown
}

type Decide = (
  approvalId: string,
  outcome: "allow" | "deny",
  // Answers to an AskUserQuestion ride the same round-trip as a plain approval.
  updatedInput?: Record<string, unknown>,
) => void

/** Tool inputs cross the wire as `unknown`; the renderer needs a plain object. */
function asToolInput(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * What a chat is waiting on, answered right in the inbox row — the one thing the
 * inbox does that jumping to the conversation cannot do as cheaply (approve a
 * tool in another project without leaving this one). Everything else about the
 * chat lives in the chat; clicking the row goes there.
 *
 * Asks that need the conversation itself (the chat's own question form, a plan
 * to review) render nothing here: the row's text already says so, and the row
 * click opens it.
 */
export function InboxApprovals({ chatId, version }: { chatId: number; version: number }) {
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .aiPendingApprovals(chatId)
      .then((res) => {
        if (!cancelled) setApprovals(res.approvals ?? [])
      })
      .catch(() => {
        // Row click still opens the conversation.
      })
    return () => {
      cancelled = true
    }
    // `version` = the row's updatedAt: a new request re-raises the row.
  }, [chatId, version])

  const decide: Decide = async (approvalId, outcome, updatedInput) => {
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

  const answerable = approvals.filter(
    (a) =>
      (a.toolName === "AskUserQuestion" && a.toolInput != null) ||
      (a.toolName !== "AskUserQuestion" &&
        a.toolName !== "ExitPlanMode" &&
        !a.approvalId.startsWith("plan-approval-")),
  )
  if (answerable.length === 0) return null

  return (
    <div className="space-y-1.5">
      {answerable.map((a) =>
        a.toolName === "AskUserQuestion" ? (
          <SubAgentQuestion key={a.approvalId} approval={a} busy={busyId === a.approvalId} onDecide={decide} />
        ) : (
          <ToolApproval key={a.approvalId} approval={a} busy={busyId === a.approvalId} onDecide={decide} />
        ),
      )}
    </div>
  )
}

function ToolApproval({
  approval,
  busy,
  onDecide,
}: {
  approval: PendingApproval
  busy: boolean
  onDecide: Decide
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground/80">{approval.toolName}</div>
        {/* The chat launched a workflow and is otherwise idle — say which
            sub-agent is blocked, or the request reads as the chat being stuck. */}
        {approval.origin ? (
          <div className="truncate text-[11px] text-muted-foreground">
            Sub-agent <span className="font-mono">{approval.origin}</span>
          </div>
        ) : null}
      </div>
      {/* Same size/shape for both; only the semantic colour differs, so they
          read as two equal choices. `status-*` carry their own light/dark values. */}
      <Button
        size="sm"
        variant="outline"
        className={cn(
          "h-7 gap-1.5 border-status-ok/25 bg-status-ok/10 text-xs text-status-ok shadow-none",
          "hover:border-status-ok/45 hover:bg-status-ok/20 hover:text-status-ok",
        )}
        disabled={busy}
        onClick={() => onDecide(approval.approvalId, "allow")}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        className={cn(
          "h-7 gap-1.5 border-status-error/25 bg-status-error/10 text-xs text-status-error shadow-none",
          "hover:border-status-error/45 hover:bg-status-error/20 hover:text-status-error",
        )}
        disabled={busy}
        onClick={() => onDecide(approval.approvalId, "deny")}
      >
        <X className="h-3.5 w-3.5" /> Deny
      </Button>
    </div>
  )
}

/**
 * A question from a detached workflow sub-agent. It has no chat page of its own
 * to open, so it is answered here: the same form the chat renders, fed a
 * synthetic tool part built from the question payload. Collapsed until asked
 * for, so one question does not blow the list row up.
 */
function SubAgentQuestion({
  approval,
  busy,
  onDecide,
}: {
  approval: PendingApproval
  busy: boolean
  onDecide: Decide
}) {
  const [open, setOpen] = useState(false)
  const toolPart: ToolInvocationPart = {
    type: "dynamic-tool",
    toolName: "AskUserQuestion",
    toolCallId: approval.approvalId,
    input: asToolInput(approval.toolInput),
    state: "approval-requested",
    approval: { id: approval.approvalId },
  }
  return (
    <div className="rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {approval.origin ? (
            <>
              Sub-agent <span className="font-mono">{approval.origin}</span> asked a question
            </>
          ) : (
            "A sub-agent asked a question"
          )}
        </span>
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Answer"}
        </Button>
      </div>
      {open ? (
        <div className={cn("mt-2", busy && "pointer-events-none opacity-60")}>
          <AskUserQuestionRenderer
            toolPart={toolPart}
            messageId={`inbox-${approval.approvalId}`}
            partIndex={0}
            onPermissionDecide={(id, outcome, updatedInput) =>
              onDecide(id, outcome === "deny" ? "deny" : "allow", updatedInput)
            }
          />
        </div>
      ) : null}
    </div>
  )
}
