/**
 * Blocked sub-agents, surfaced where the user already is.
 *
 * - `WorkflowApprovalPrompt` — one blocked sub-agent, answerable in place. Also
 *   used by the panel's run detail (`WorkflowRunDetail`).
 * - `WorkflowApprovalsBar` — this conversation's blocked sub-agents, above the
 *   composer.
 *
 * Subscriptions live in `WorkflowRunsSync` (global, mounted once); run detail
 * lives in the workflow panel tab. This file only renders the interruption.
 */

import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Loader2, CheckIcon, XIcon, CircleAlert as CircleAlertIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { api, type WorkflowPendingApprovalView } from '@/lib/api';
import { useWorkflowRunsStore, selectBlockedRuns } from '@/stores/workflow-runs-store';
import { AskUserQuestionRenderer, type ToolInvocationPart } from './AskUserQuestionRenderer';

// ---------------------------------------------------------------------------
// Blocked sub-agent — answered here, on the run the user is watching
// ---------------------------------------------------------------------------

/** Tool inputs cross the wire as `unknown`; the question renderer needs an object. */
function asToolInput(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A sub-agent waiting on a human, rendered inside its own run.
 *
 * A sub-agent's session is detached — it has no chat page of its own to open —
 * so the request has to be answerable from the surfaces that DO exist. This is
 * the primary one: the user launched this run and is watching this card. The
 * approval inbox carries the same request for when the app isn't in front of
 * them; either one answers, and the other clears.
 *
 * `chatId` is the launching conversation, which is what the server checks the
 * decision against — a run with no launching chat can only time out.
 */
export function WorkflowApprovalPrompt({
  approval,
  chatId,
}: {
  approval: WorkflowPendingApprovalView;
  chatId?: number | null;
}) {
  const [busy, setBusy] = useState(false);
  const decide = async (
    outcome: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
  ) => {
    if (chatId == null) return;
    setBusy(true);
    try {
      await api.aiPermissionResponse({
        id: approval.approvalId,
        outcome: updatedInput ? { outcome, updatedInput } : outcome,
        chatId,
      });
      // No local dismissal: the server answers the sub-agent and publishes
      // `approval-resolved`, which removes this card from every surface at once.
    } finally {
      setBusy(false);
    }
  };

  const questionInput =
    approval.toolName === 'AskUserQuestion' ? asToolInput(approval.toolInput) : undefined;

  return (
    <div className="space-y-2 rounded-lg border border-status-warn/25 bg-status-warn/10 p-2.5">
      <div className="flex items-center gap-2 text-xs text-status-warn">
        <CircleAlertIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-mono">{approval.agentId}</span>
        <span className="text-muted-foreground">
          {questionInput ? 'asked you a question' : `needs approval · ${approval.toolName}`}
        </span>
      </div>

      {chatId == null ? (
        // Nothing to answer against: the decision is checked against the chat
        // that launched the run, and this one has none. Say so rather than
        // showing buttons that would silently do nothing.
        <div className="text-xs text-muted-foreground">
          This run has no launching conversation, so it can't be answered here.
        </div>
      ) : questionInput ? (
        <div className={cn(busy && 'pointer-events-none opacity-60')}>
          <AskUserQuestionRenderer
            toolPart={
              {
                type: 'dynamic-tool',
                toolName: 'AskUserQuestion',
                toolCallId: approval.approvalId,
                input: questionInput,
                state: 'approval-requested',
                approval: { id: approval.approvalId },
              } satisfies ToolInvocationPart
            }
            messageId={`workflow-${approval.approvalId}`}
            partIndex={0}
            onPermissionDecide={(_id, outcome, updatedInput) =>
              void decide(outcome === 'deny' ? 'deny' : 'allow', updatedInput)
            }
          />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className={cn(
              'h-7 gap-1.5 border-status-ok/25 bg-status-ok/10 text-xs text-status-ok shadow-none',
              'hover:border-status-ok/45 hover:bg-status-ok/20 hover:text-status-ok',
            )}
            disabled={busy}
            onClick={() => void decide('allow')}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckIcon className="h-3 w-3" />}
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={cn(
              'h-7 gap-1.5 border-status-error/25 bg-status-error/10 text-xs text-status-error shadow-none',
              'hover:border-status-error/45 hover:bg-status-error/20 hover:text-status-error',
            )}
            disabled={busy}
            onClick={() => void decide('deny')}
          >
            <XIcon className="h-3 w-3" />
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Watcher — owns the streams, renders only the blocking approvals
// ---------------------------------------------------------------------------

/** Live snapshot of one run, as lifted out of its stream subscriber. */
/**
 * The one workflow thing that must interrupt: a sub-agent blocked on a human.
 *
 * Everything else about a run is shown in the workflow panel tab — a run's detail
 * is a sub-agent's full stream, which has no business stacked on top of the input
 * box. But a blocked sub-agent stops the run and is auto-denied after a timeout,
 * so it has to appear where the user already is, without them opening anything.
 *
 * Reads the global store; it neither subscribes nor polls. `WorkflowRunsSync`
 * owns every subscription, once, for the whole app — and the node delivers a
 * finished run's result to its conversation on its own
 * (`services/workflow/completion.ts`), so nothing here has to stay mounted for a
 * run to complete correctly.
 */
export function WorkflowApprovalsBar({ chatId }: { chatId?: number | null }) {
  // `useShallow`: the selector derives a fresh array every call, and zustand v5
  // compares snapshots by reference — without it React sees a new value on every
  // render and loops until it throws "Maximum update depth exceeded".
  const blocked = useWorkflowRunsStore(useShallow((s) => selectBlockedRuns(s, chatId)));
  if (blocked.length === 0) return null;

  return (
    <div className="mb-2 space-y-2">
      {blocked.flatMap((run) =>
        (run.pendingApprovals ?? []).map((approval) => (
          <WorkflowApprovalPrompt key={approval.approvalId} approval={approval} chatId={run.chatId} />
        )),
      )}
    </div>
  );
}
