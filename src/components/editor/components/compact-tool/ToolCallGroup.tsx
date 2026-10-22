import { ChevronRightIcon, LoaderIcon, CheckIcon, XIcon } from 'lucide-react';
import type { UIMessage } from 'ai';
import type { ReactNode } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import type { ConfirmationProps } from '@/components/ai-elements/confirmation';
import type { ToolPart } from '@/components/ai-elements/tool';
import { cn } from '@/lib/utils';
import { isToolPart } from '../toolParentUtils';
import type { ToolPartLike } from '../toolName';
import { normalizeToolState } from '../toolState';
import { buildToolGroupSummary } from './buildToolGroupSummary';
import { CompactToolCall } from './CompactToolCall';
import type { PermissionOutcome } from '../permission-utils';
import { isCodeProgramTool } from '../codeProgram';

type MessagePart = UIMessage['parts'][number];

type ToolInvocationPart = ToolPartLike & {
  state?: string;
  result?: ToolPart['output'];
  output?: ToolPart['output'];
  errorText?: string;
  approval?: NonNullable<ConfirmationProps['approval']>;
  toolCallId?: string;
};

interface ToolCallGroupProps {
  parts: MessagePart[];
  partIndices: number[];
  messageId: string;
  renderProgram: (partIndex: number) => ReactNode;
  hasPendingApproval?: boolean;
  onPermissionDecide: (id: string, outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => Promise<boolean>;
}

const isReasoningPart = (part: MessagePart): part is MessagePart & { type: 'reasoning'; text: string } =>
  part.type === 'reasoning';

/** Build the collapsed one-line summary, e.g. "Thought · Read 2 files, ran 1 command". */
function buildGroupSummary(toolParts: ToolInvocationPart[], reasoningCount: number): string {
  const chunks: string[] = [];
  if (reasoningCount > 0) chunks.push('Thought');
  if (toolParts.length > 0) chunks.push(buildToolGroupSummary(toolParts));
  return chunks.join(' · ') || 'Worked';
}

function GroupStatusIndicator({ toolParts, hasPendingApproval }: { toolParts: ToolInvocationPart[]; hasPendingApproval: boolean }) {
  if (toolParts.length === 0) return null;
  const states = toolParts.map((p) => normalizeToolState(p.state));
  const hasRunning = states.some((s) => s === 'input-streaming' || s === 'input-available');
  const hasError = states.some((s) => s === 'output-error' || s === 'output-denied');
  const hasApproval = hasPendingApproval || states.some((s) => s === 'approval-requested');

  if (hasApproval) return <span className="block size-2 rounded-full bg-status-warn animate-pulse" />;
  if (hasRunning) return <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />;
  if (hasError) return <XIcon className="size-3.5 text-status-error" />;
  return <CheckIcon className="size-3.5 text-status-ok" />;
}

/** Renders one part inside a work group: a compact tool row, or a foldable thought. */
function GroupItem({
  part,
  partIndex,
  messageId,
  onPermissionDecide,
  renderProgram,
}: {
  part: MessagePart;
  partIndex: number;
  messageId: string;
  onPermissionDecide: ToolCallGroupProps['onPermissionDecide'];
  renderProgram: ToolCallGroupProps['renderProgram'];
}) {
  if (isToolPart(part) && isCodeProgramTool(part as ToolPartLike)) {
    return renderProgram(partIndex);
  }
  if (isReasoningPart(part)) {
    return (
      <Reasoning className="w-full" defaultOpen={false}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }
  return (
    <CompactToolCall
      toolPart={part as ToolInvocationPart}
      messageId={messageId}
      partIndex={partIndex}
      onPermissionDecide={onPermissionDecide}
    />
  );
}

export function ToolCallGroup({
  parts,
  partIndices,
  messageId,
  onPermissionDecide,
  renderProgram,
  hasPendingApproval = false,
}: ToolCallGroupProps) {
  // Single item: render directly without the group wrapper.
  if (parts.length === 1 && !isCodeProgramTool(parts[0] as ToolPartLike)) {
    return (
      <GroupItem
        part={parts[0]}
        partIndex={partIndices[0]}
        messageId={messageId}
        onPermissionDecide={onPermissionDecide}
        renderProgram={renderProgram}
      />
    );
  }

  const toolParts = parts.filter(isToolPart) as ToolInvocationPart[];
  const reasoningCount = parts.filter(isReasoningPart).length;
  const hasApproval = hasPendingApproval || toolParts.some((p) => normalizeToolState(p.state) === 'approval-requested');
  const summary = buildGroupSummary(toolParts, reasoningCount);

  return (
    <Collapsible
      {...(hasApproval ? { open: true } : {})}
      className={cn('group/tool-group')}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-left">
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/60 transition-transform group-data-[state=open]/tool-group:rotate-90" />
        <span className="text-sm text-muted-foreground">
          {summary}
        </span>
        <span className="ml-auto shrink-0">
          <GroupStatusIndicator toolParts={toolParts} hasPendingApproval={hasPendingApproval} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-2 border-l border-border/40 ml-1.5 space-y-0">
        {parts.map((part, i) => (
          <GroupItem
            key={`${messageId}-${partIndices[i]}`}
            part={part}
            partIndex={partIndices[i]}
            messageId={messageId}
            onPermissionDecide={onPermissionDecide}
            renderProgram={renderProgram}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
