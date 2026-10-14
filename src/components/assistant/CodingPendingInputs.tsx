import { useState } from "react"
import { Loader2, ShieldQuestion } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { toast } from "sonner"
import { api, type PermissionOutcome } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { AskUserQuestionRenderer, type ToolInvocationPart } from "@/components/editor/components/AskUserQuestionRenderer"
import { PlanRenderer } from "@/components/editor/components/PlanRenderer"
import { cn } from "@/lib/utils"
import type { CodingPendingInput } from "@shared/assistant"

/** Tool inputs cross the wire as `unknown`; the renderers want a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

const isPlan = (p: CodingPendingInput) => p.toolName === "ExitPlanMode" || p.approvalId.startsWith("plan-approval-")

/**
 * What a coding agent's conversation is waiting on, answered right on its card in the assistant
 * thread — the same forms its conversation shows (a question, a plan to review) or a plain
 * allow / deny, through the same permission response. Once answered the server clears it and the
 * card goes back to running.
 */
export function CodingPendingInputs({ chatId, pending }: { chatId: number; pending: CodingPendingInput[] }) {
  const intl = useIntl()
  const [busy, setBusy] = useState<string | null>(null)

  const decide = async (approvalId: string, outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => {
    setBusy(approvalId)
    try {
      const kind = typeof outcome === "string" ? outcome : outcome.outcome
      const res = await api.aiPermissionResponse({
        id: approvalId,
        outcome: updatedInput ? { outcome: kind, updatedInput } : outcome,
        chatId,
      })
      if (!res.success) {
        toast.error(intl.formatMessage({ id: "assistant.coding.answerStale", defaultMessage: "That request is no longer waiting." }))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-2">
      {pending.map((p) => {
        const input = asRecord(p.input)
        const part: ToolInvocationPart = {
          type: "dynamic-tool",
          toolName: p.toolName,
          toolCallId: p.approvalId,
          input,
          state: "approval-requested",
          approval: { id: p.approvalId },
        }
        const formBusy = cn(busy === p.approvalId && "pointer-events-none opacity-60")

        if (p.toolName === "AskUserQuestion" && input) {
          return (
            <div key={p.approvalId} className={formBusy}>
              <AskUserQuestionRenderer
                toolPart={part}
                messageId={`assistant-coding-${p.approvalId}`}
                partIndex={0}
                onPermissionDecide={(id, outcome, updatedInput) => void decide(id, outcome, updatedInput)}
              />
            </div>
          )
        }
        if (isPlan(p) && input) {
          const planMarkdown = typeof input.plan === "string" ? input.plan : undefined
          const planPath = typeof input.plan_path === "string" ? input.plan_path : undefined
          return (
            <div key={p.approvalId} className={formBusy}>
              <PlanRenderer
                toolPart={part}
                planMarkdown={planMarkdown}
                planPath={planPath}
                messageId={`assistant-coding-${p.approvalId}`}
                partIndex={0}
                isGemini={!!planPath && !planMarkdown}
                onPermissionDecide={(id, outcome, updatedInput) => void decide(id, outcome, updatedInput)}
              />
            </div>
          )
        }
        return (
          <div key={p.approvalId} className="flex items-center gap-3 rounded-lg border border-border/40 bg-background/40 p-3">
            <ShieldQuestion className="h-4 w-4 shrink-0 text-status-warn" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">
                <FormattedMessage
                  id="assistant.coding.wantsTo"
                  defaultMessage="Wants to use {tool}"
                  values={{ tool: <span className="font-mono">{p.toolName}</span> }}
                />
              </div>
              {p.preview && (
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={p.preview}>
                  {p.preview}
                </div>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              disabled={busy === p.approvalId}
              onClick={() => void decide(p.approvalId, "deny")}
            >
              <FormattedMessage id="assistant.coding.deny" defaultMessage="Deny" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-8 gap-1.5"
              disabled={busy === p.approvalId}
              onClick={() => void decide(p.approvalId, "allow")}
            >
              {busy === p.approvalId && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <FormattedMessage id="assistant.coding.allow" defaultMessage="Allow" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}
