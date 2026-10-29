import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { CheckIcon, XIcon } from 'lucide-react';
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import type { ConfirmationProps } from '@/components/ai-elements/confirmation';
import { Tool, ToolContent, ToolInput, ToolLine, ToolOutput, toolTraceStatus } from '@/components/ai-elements/tool';
import type { ToolPart } from '@/components/ai-elements/tool';
import { TraceCollapsibleTrigger, TraceDescription } from '@/components/ui/trace';
import { ToolIcon } from './ToolIcon';
import { getToolDisplayName, getToolDescription, formatToolDisplayName, unwrapToolEnvelope, type ToolPartLike } from '../toolName';
import { normalizeToolState } from '../toolState';
import { ToolInputDiff } from '../ToolInputDiff';
import { extractPermissionOptions, type PermissionOutcome } from '../permission-utils';
import { getOptimisticPermissionOutcome, type OptimisticPermissionDecision } from '../optimisticPermission';

interface CompactToolCallProps {
  toolPart: ToolInvocationPart;
  messageId: string;
  partIndex: number;
  onPermissionDecide: (id: string, outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => Promise<boolean>;
}

type ToolInvocationPart = ToolPartLike & {
  state?: string;
  result?: ToolPart['output'];
  output?: ToolPart['output'];
  errorText?: string;
  approval?: NonNullable<ConfirmationProps['approval']>;
  toolCallId?: string;
};

export function CompactToolCall({
  toolPart,
  onPermissionDecide,
}: CompactToolCallProps) {
  const serverState = normalizeToolState(toolPart.state);
  const rawInput = (toolPart.args || toolPart.input || {}) as Record<string, unknown>;
  const output = toolPart.result ?? toolPart.output;
  const hasOutput = output !== undefined && output !== null;
  // Permission options live on the outer envelope, so they are extracted before
  // unwrapping; only the displayed name/args are unwrapped.
  const { options, displayInput: envelopeInput } = extractPermissionOptions(rawInput);
  const { toolName, input: displayInput } = unwrapToolEnvelope(
    getToolDisplayName(toolPart),
    envelopeInput,
  );

  const approvalId = toolPart.approval?.id ?? toolPart.toolCallId;
  const [optimisticDecision, setOptimisticDecision] = useState<OptimisticPermissionDecision | null>(null);
  const optimisticOutcome = getOptimisticPermissionOutcome(approvalId, optimisticDecision);
  const state = optimisticOutcome && serverState === 'approval-requested'
    ? 'approval-responded'
    : serverState;

  const needsApproval = state === 'approval-requested';

  const baseApproval: ConfirmationProps['approval'] =
    toolPart.approval ?? (approvalId ? { id: approvalId } : undefined);
  const approval = optimisticOutcome && baseApproval
    ? { ...baseApproval, approved: optimisticOutcome !== 'deny' }
    : baseApproval;

  const handlePermissionDecide = (outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => {
    if (!approvalId) return;
    const decision: OptimisticPermissionDecision = {
      approvalId,
      outcome: outcome === 'deny' ? 'deny' : 'allow',
    };
    setOptimisticDecision(decision);
    void onPermissionDecide(approvalId, outcome, updatedInput).then((accepted) => {
      if (accepted) return;
      setOptimisticDecision((current) => current === decision ? null : current);
    });
  };

  const lowerToolName = toolName.toLowerCase();
  const shouldUseDiffView = lowerToolName === 'edit' || lowerToolName === 'write' ||
    lowerToolName === 'tool-edit' || lowerToolName === 'tool-write' ||
    lowerToolName === 'replace' || lowerToolName === 'write_file' ||
    lowerToolName === 'patch';

  const commandDescription = getToolDescription(lowerToolName, displayInput);

  const line = (
    <ToolLine
      icon={<ToolIcon toolName={toolName} />}
      name={formatToolDisplayName(toolName)}
      description={commandDescription}
      status={toolTraceStatus(state)}
      trailing={state === 'output-denied' ? (
        <TraceDescription><FormattedMessage id="editor.confirm.denied" defaultMessage="Denied" /></TraceDescription>
      ) : undefined}
    />
  );

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Tool data-tool-state={state}>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <ToolContent>
          {shouldUseDiffView ? (
            <ToolInputDiff toolName={toolName} input={displayInput} />
          ) : (
            <ToolInput input={displayInput} />
          )}
          {(hasOutput || toolPart.errorText) && (
            <ToolOutput output={output} errorText={toolPart.errorText} />
          )}
        </ToolContent>
      </Tool>

      {/* A pending approval is a question for the person, not a step, so it sits
          under the line as an Item rather than inside the collapsible. */}
      {needsApproval && (
        <Confirmation approval={approval} state={state} icon={<ToolIcon toolName={toolName} className="size-4 text-muted-foreground" />}>
          <ConfirmationTitle>
            <ConfirmationRequest>
              <FormattedMessage id="editor.confirm.requestTool" defaultMessage="The assistant requests permission to execute this tool." />
            </ConfirmationRequest>
            <ConfirmationAccepted>
              <CheckIcon className="size-4 text-status-ok" />
              <span><FormattedMessage id="editor.confirm.accepted" defaultMessage="Accepted" /></span>
            </ConfirmationAccepted>
            <ConfirmationRejected>
              <XIcon className="size-4 text-status-error" />
              <span><FormattedMessage id="editor.confirm.rejected" defaultMessage="Rejected" /></span>
            </ConfirmationRejected>
          </ConfirmationTitle>
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
                // One solid button: the plain allow. "Allow always" and the like
                // sit beside it as secondary so the default choice reads first.
                variant={i === 0 ? 'default' : 'secondary'}
                onClick={() => handlePermissionDecide(opt.outcome, opt.updatedInput)}
              >
                {opt.label}
              </ConfirmationAction>
            ))}
          </ConfirmationActions>
        </Confirmation>
      )}
    </div>
  );
}
