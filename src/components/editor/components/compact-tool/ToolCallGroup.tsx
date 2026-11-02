import type { UIMessage } from 'ai';
import { useState, type ReactNode } from 'react';
import { ListTreeIcon } from 'lucide-react';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import type { ConfirmationProps } from '@/components/ai-elements/confirmation';
import type { ToolPart } from '@/components/ai-elements/tool';
import { isToolPart } from '../toolParentUtils';
import type { ToolPartLike } from '../toolName';
import { normalizeToolState } from '../toolState';
import { buildToolGroupSummary } from './buildToolGroupSummary';
import { CompactToolCall } from './CompactToolCall';
import type { PermissionOutcome } from '../permission-utils';
import { isCodeProgramTool } from '../codeProgram';
import { TodoWriteRenderer, isTodoWriteTool } from '../TodoWriteRenderer';
import { ImageReadRenderer } from '../ImageReadRenderer';
import { ReadImagesRow, imageReadPathOf } from '../ReadImages';

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

/** Renders one part inside a work group: a compact tool row, or a foldable thought. */
function GroupItem({
  part,
  partIndex,
  messageId,
  onPermissionDecide,
  renderProgram,
  standalone = false,
}: {
  part: MessagePart;
  partIndex: number;
  messageId: string;
  onPermissionDecide: ToolCallGroupProps['onPermissionDecide'];
  renderProgram: ToolCallGroupProps['renderProgram'];
  /** Drawn in place of a group of one, so no summary row carries its images. */
  standalone?: boolean;
}) {
  if (isToolPart(part) && isCodeProgramTool(part as ToolPartLike)) {
    return renderProgram(partIndex);
  }
  // A todo update reads as the list it set, here as when it stands alone.
  if (isToolPart(part) && isTodoWriteTool(part as ToolPartLike)) {
    return <TodoWriteRenderer toolPart={part as ToolInvocationPart} messageId={messageId} partIndex={partIndex} />;
  }
  // A Read of an image standing alone (a group of one) keeps its picture in view,
  // as a folded group would. Inside an opened group it is a plain row; opening
  // the row shows the picture.
  const imagePath = standalone && isToolPart(part) ? imageReadPathOf(part as ToolInvocationPart) : null;
  if (imagePath !== null) {
    return (
      <ImageReadRenderer
        toolPart={part as ToolInvocationPart}
        path={imagePath}
        messageId={messageId}
        partIndex={partIndex}
        onPermissionDecide={onPermissionDecide}
      />
    );
  }
  if (isReasoningPart(part)) {
    return (
      <Reasoning empty={!part.text.trim()}>
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
  const [open, setOpen] = useState(false);
  // Single item: render directly without the group wrapper.
  if (parts.length === 1 && !isCodeProgramTool(parts[0] as ToolPartLike)) {
    return (
      <GroupItem
        standalone
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
  const states = toolParts.map((p) => normalizeToolState(p.state));
  const running = states.some((s) => s === 'input-streaming' || s === 'input-available');
  const failed = states.filter((s) => s === 'output-error').length;
  const hasApproval = hasPendingApproval || states.includes('approval-requested');
  const summary = buildGroupSummary(toolParts, reasoningCount);
  const isOpen = hasApproval || open;
  // Images the group read stay in view while it is folded: small beside the
  // summary on desktop, a gallery under it on a phone. Opened, they go: each
  // Read row shows its image when that row is opened.
  const imagePaths = isOpen
    ? []
    : [...new Set(toolParts.map((p) => imageReadPathOf(p)).filter((p): p is string => p !== null))];

  return (
    <ToolGroupCollapsible open={isOpen} onOpenChange={setOpen}>
      <ReadImagesRow paths={imagePaths}>
        <TraceCollapsibleTrigger>
          <TraceLine status={running ? 'running' : undefined}>
            <TraceIcon><ListTreeIcon /></TraceIcon>
            <TraceTitle>{summary}</TraceTitle>
            {failed > 0 && !running && (
              <TraceDescription className="text-status-error">{failed} failed</TraceDescription>
            )}
          </TraceLine>
        </TraceCollapsibleTrigger>
      </ReadImagesRow>
      <TraceCollapsibleContent>
        <Trace>
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
        </Trace>
      </TraceCollapsibleContent>
    </ToolGroupCollapsible>
  );
}

/**
 * The group's open state (held by ToolCallGroup, whose folded summary depends on
 * it): closed unless the person opens it, or one of its steps waits on an
 * approval (so the question is in view).
 *
 * It does not open while a step runs. The step streaming right now always sits
 * outside the group (segmentMessageParts keeps the active tail as its own
 * segment), so a running step in here is an older parallel call that hasn't
 * returned yet — opening for it popped an already-folded group open mid-turn.
 * The header's shimmer says the group is still working.
 */
function ToolGroupCollapsible({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={onOpenChange}>
        {children}
      </TraceCollapsible>
    </Trace>
  );
}
