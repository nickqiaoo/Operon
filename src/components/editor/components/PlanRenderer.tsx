import { useState, useEffect } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { api } from '@/lib/api';
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import type { ConfirmationProps } from '@/components/ai-elements/confirmation';
import { MessageResponse } from '@/components/ai-elements/message';
import {
  Plan,
  PlanContent,
  PlanDescription,
  PlanHeader,
  PlanTitle,
} from '@/components/ai-elements/plan';
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace';
import { FileText } from 'lucide-react';
import { normalizeToolState } from './toolState';
import { type ToolPartLike } from './toolName';
import { extractPermissionOptions, type PermissionOption, type PermissionOutcome } from './permission-utils';

interface PlanRendererProps {
  toolPart: PlanToolPart;
  planMarkdown?: string;
  /** Path to a plan file (Gemini). Content will be loaded if planMarkdown is absent. */
  planPath?: string;
  messageId: string;
  partIndex: number;
  onPermissionDecide: (id: string, outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => void;
  /** Gemini plan mode — enables feedback input and approval mode selection */
  isGemini?: boolean;
}

type PlanToolPart = ToolPartLike & {
  state?: string;
  approval?: NonNullable<ConfirmationProps['approval']>;
  toolCallId?: string;
};

export function PlanRenderer({
  toolPart,
  planMarkdown: planMarkdownProp,
  planPath,
  messageId,
  partIndex,
  onPermissionDecide,
  isGemini,
}: PlanRendererProps) {
  const intl = useIntl();
  const PLAN_DEFAULTS: PermissionOption[] = [
    { outcome: 'deny', label: intl.formatMessage({ id: 'editor.plan.keepPlanning', defaultMessage: 'No, keep planning' }), tone: 'reject' },
    { outcome: 'allow', label: intl.formatMessage({ id: 'editor.plan.startCoding', defaultMessage: 'Yes, start coding' }), tone: 'allow' },
  ];
  const state = normalizeToolState(toolPart.state);
  const rawInput = (toolPart.args || toolPart.input || {}) as Record<string, unknown>;
  const { options } = extractPermissionOptions(rawInput, PLAN_DEFAULTS);
  const [feedback, setFeedback] = useState('');
  const [fileContent, setFileContent] = useState<string | null>(null);

  useEffect(() => {
    if (planPath && !planMarkdownProp) {
      api.readFile(planPath).then((content) => setFileContent(content)).catch(() => setFileContent(null));
    }
  }, [planPath, planMarkdownProp]);

  const planMarkdown = planMarkdownProp || fileContent || (planPath ? intl.formatMessage({ id: 'editor.plan.loading', defaultMessage: 'Loading plan...' }) : '');
  const planLines = planMarkdown.split('\n');
  const titleLine = planLines.find((line) => line.startsWith('# '));
  const planTitle = titleLine ? titleLine.replace(/^#\s+/, '') : intl.formatMessage({ id: 'editor.plan.title', defaultMessage: 'Implementation Plan' });

  // Use the approvalId from the AI SDK's tool-approval-request chunk (stored in toolPart.approval.id)
  // This is the UUID the server uses to look up pending permissions, NOT the toolCallId.
  const approvalId = toolPart.approval?.id ?? toolPart.toolCallId;
  const approval: ConfirmationProps['approval'] =
    toolPart.approval ?? (approvalId ? { id: approvalId } : undefined);
  const handlePermissionDecide = (outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => {
    if (!approvalId) return;
    if (isGemini) {
      // Gemini exit_plan_mode: always use 'allow' so the tool actually executes.
      // 'deny' maps to Cancel which triggers cancelAll() — the tool never runs
      // and feedback is lost. The payload's `approved` field controls the behavior.
      const payload: Record<string, unknown> = outcome === 'deny'
        ? { approved: false, feedback: feedback.trim() || undefined }
        : { approved: true, approvalMode: outcome === 'allowAlways' ? 'autoEdit' : 'default' };
      onPermissionDecide(approvalId, 'allow', payload);
    } else {
      onPermissionDecide(approvalId, outcome, updatedInput);
    }
  };

  const awaitingReview = state === 'approval-requested';
  const planStatus = awaitingReview
    ? intl.formatMessage({ id: 'editor.plan.awaitingReview', defaultMessage: 'Awaiting review' })
    : intl.formatMessage({ id: 'editor.plan.submitted', defaultMessage: 'Plan submitted.' });

  return (
    <div key={`${messageId}-${partIndex}`} className="flex min-w-0 flex-col gap-2">
      {planMarkdown ? (
        <Plan defaultOpen={awaitingReview}>
          <PlanHeader icon={<FileText />}>
            <PlanTitle>{planTitle}</PlanTitle>
            <PlanDescription>{planStatus}</PlanDescription>
          </PlanHeader>
          <PlanContent className="text-foreground">
            <MessageResponse>{planMarkdown}</MessageResponse>
          </PlanContent>
        </Plan>
      ) : (
        // Codex writes the plan as the reply itself, above: nothing to open here.
        <Trace>
          <TraceLine>
            <TraceIcon><FileText /></TraceIcon>
            <TraceTitle>{planTitle}</TraceTitle>
            <TraceDescription>{planStatus}</TraceDescription>
          </TraceLine>
        </Trace>
      )}
      {state === 'approval-requested' && (
        <Confirmation approval={approval} state={state} icon={<FileText className="text-muted-foreground" />}>
          <ConfirmationTitle>
            {intl.formatMessage({ id: 'editor.plan.reviewPrompt', defaultMessage: 'Review and approve this plan to proceed.' })}
          </ConfirmationTitle>
          {/* Gemini: feedback input for rejection */}
          {isGemini && (
            <div className="order-last basis-full">
              <input
                type="text"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder={intl.formatMessage({ id: 'editor.plan.feedbackPlaceholder', defaultMessage: 'Optional feedback if rejecting...' })}
                className="h-8 w-full rounded-lg border border-border/50 bg-background px-3 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-tint/40 dark:border-border/35"
              />
            </div>
          )}
          <ConfirmationActions data-testid="permission-dialog">
            {options.filter(o => o.tone === 'reject').map((opt, i) => (
              <ConfirmationAction
                key={`reject-${i}`}
                data-testid={`permission-reject-${opt.outcome}`}
                tone="reject"
                variant="outline"
                onClick={() => handlePermissionDecide(opt.outcome, opt.updatedInput)}
              >
                {opt.label}
              </ConfirmationAction>
            ))}
            {options.filter(o => o.tone === 'allow').map((opt, i) => (
              <ConfirmationAction
                key={`allow-${i}`}
                data-testid={`permission-allow-${opt.outcome}`}
                tone="allow"
                variant={i === 0 ? 'default' : 'secondary'}
                onClick={() => handlePermissionDecide(opt.outcome, opt.updatedInput)}
              >
                {opt.label}
              </ConfirmationAction>
            ))}
            {/* Gemini: additional "Auto Edit" mode option */}
            {isGemini && (
              <ConfirmationAction
                data-testid="permission-allow-allowAlways"
                tone="allow"
                variant="outline"
                onClick={() => handlePermissionDecide('allowAlways')}
              >
                <FormattedMessage id="editor.plan.startCodingAutoEdit" defaultMessage="Start coding (auto-edit)" />
              </ConfirmationAction>
            )}
          </ConfirmationActions>
        </Confirmation>
      )}
    </div>
  );
}
