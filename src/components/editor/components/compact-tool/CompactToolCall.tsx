import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { CheckIcon, XIcon, ChevronRightIcon, LoaderIcon } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
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
import { ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import type { ToolPart } from '@/components/ai-elements/tool';
import { cn } from '@/lib/utils';
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

function StatusIndicator({ state }: { state: string }) {
  switch (state) {
    case 'input-streaming':
    case 'input-available':
      return <LoaderIcon className="size-3 animate-spin text-muted-foreground" />;
    case 'output-available':
    case 'approval-responded':
      return <CheckIcon className="size-3 text-green-600 dark:text-green-400" />;
    case 'output-error':
    case 'output-denied':
      return <XIcon className="size-3 text-destructive" />;
    case 'approval-requested':
      return <span className="size-2 rounded-full bg-yellow-500 animate-pulse" />;
    default:
      return null;
  }
}

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

  return (
    <Collapsible
      {...(needsApproval ? { open: true } : {})}
      className={cn(
        'group/compact',
        state === 'output-error' && 'text-destructive',
      )}
    >
      <CollapsibleTrigger
        data-testid="tool-invocation"
        data-tool-state={state}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/60 transition-transform group-data-[state=open]/compact:rotate-90" />
        {/* The name identifies the row, so it truncates last. Flex distributes
            shrinkage by basis, so leaving it shrinkable clipped even a 4-char
            "Bash" down to "Ba…" whenever the command beside it was long. With a
            description present the name is unshrinkable and the command absorbs
            all of it; `max-w` is the escape hatch for providers that hand us the
            whole shell command AS the name — an unshrinkable 1200px label would
            otherwise blow the row past the window edge. With no description the
            name is the only thing that can give, so it shrinks as before. */}
        <span
          data-testid="tool-name"
          className={cn(
            'truncate text-sm font-medium text-muted-foreground',
            commandDescription ? 'shrink-0 max-w-[60%]' : 'min-w-0',
          )}
        >
          {formatToolDisplayName(toolName)}
        </span>
        {commandDescription && (
          <code className="min-w-0 truncate text-xs text-muted-foreground/70 font-mono">
            {commandDescription}
          </code>
        )}
        <span className="ml-auto shrink-0">
          <StatusIndicator state={state} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-[18px] pb-1">
        {shouldUseDiffView ? (
          <ToolInputDiff toolName={toolName} input={displayInput} />
        ) : (
          <ToolInput input={displayInput} className="p-0 [&_h4]:hidden" />
        )}

        {needsApproval && (
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
        )}

        {(hasOutput || toolPart.errorText) && (
          <ToolOutput output={output} errorText={toolPart.errorText} className="p-0 pt-1 [&_h4]:hidden [&_.max-h-80]:max-h-40 [&_[data-slot=scroll-area-viewport]]:!max-h-40" />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
