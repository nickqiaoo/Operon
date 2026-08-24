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
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import type { ToolPart } from '@/components/ai-elements/tool';
import { getToolDisplayName, getToolDescription, formatToolDisplayName, unwrapToolEnvelope, type ToolPartLike } from './toolName';
import { normalizeToolState } from './toolState';
import { ToolInputDiff } from './ToolInputDiff';
import { extractPermissionOptions, type PermissionOutcome } from './permission-utils';
import {
  getOptimisticPermissionOutcome,
  type OptimisticPermissionDecision,
} from './optimisticPermission';

interface ToolInvocationRendererProps {
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

export function ToolInvocationRenderer({
  toolPart,
  messageId,
  partIndex,
  onPermissionDecide,
}: ToolInvocationRendererProps) {
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

  // Use the approvalId from the AI SDK's tool-approval-request chunk (stored in toolPart.approval.id)
  // This is the UUID the server uses to look up pending permissions, NOT the toolCallId.
  const approvalId = toolPart.approval?.id ?? toolPart.toolCallId;

  // One node_repl tool call can raise several approvals in a row, so the
  // optimistic state has to be keyed by approvalId rather than by the call.
  const [optimisticDecision, setOptimisticDecision] = useState<OptimisticPermissionDecision | null>(null);
  const optimisticOutcome = getOptimisticPermissionOutcome(approvalId, optimisticDecision);
  const state = optimisticOutcome && serverState === 'approval-requested'
    ? 'approval-responded'
    : serverState;

  // Only auto-expand when approval is requested
  const shouldExpand = state === 'approval-requested';

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

  // Check if this tool should use diff view (Edit/Write and provider equivalents)
  const lowerToolName = toolName.toLowerCase();
  const shouldUseDiffView = lowerToolName === 'edit' || lowerToolName === 'write' ||
                            lowerToolName === 'tool-edit' || lowerToolName === 'tool-write' ||
                            lowerToolName === 'replace' || lowerToolName === 'write_file' ||
                            lowerToolName === 'patch';

  // Extract a short description from tool input to show in the collapsed header
  const commandDescription = getToolDescription(lowerToolName, displayInput);

  return (
    <Tool
      key={`${messageId}-${partIndex}`}
      {...(shouldExpand ? { open: true } : {})}
      className={state === 'output-error' ? 'border-destructive/50 bg-destructive/5' : undefined}
    >
      <ToolHeader type="dynamic-tool" toolName={formatToolDisplayName(toolName)} state={state} description={commandDescription} />
      <ToolContent>
        {shouldUseDiffView ? (
          <ToolInputDiff toolName={toolName} input={displayInput} />
        ) : (
          <ToolInput input={displayInput} />
        )}
        <Confirmation approval={approval} state={state}>
          <ConfirmationTitle>
            <ConfirmationRequest>
              <FormattedMessage id="editor.confirm.requestTool" defaultMessage="The assistant requests permission to execute this tool." />
            </ConfirmationRequest>
            <ConfirmationAccepted>
              <CheckIcon className="size-4 text-green-600 dark:text-green-400" />
              <span><FormattedMessage id="editor.confirm.accepted" defaultMessage="Accepted" /></span>
            </ConfirmationAccepted>
            <ConfirmationRejected>
              <XIcon className="size-4 text-destructive" />
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
                variant="default"
                onClick={() => handlePermissionDecide(opt.outcome, opt.updatedInput)}
              >
                {opt.label}
              </ConfirmationAction>
            ))}
          </ConfirmationActions>
        </Confirmation>
        {(hasOutput || toolPart.errorText) ? <ToolOutput output={output} errorText={toolPart.errorText} /> : null}
      </ToolContent>
    </Tool>
  );
}
