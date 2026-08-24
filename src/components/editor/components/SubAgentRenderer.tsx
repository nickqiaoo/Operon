import { useState } from 'react';
import { FormattedMessage, useIntl, type IntlShape } from 'react-intl';
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  TerminalIcon,
  FileTextIcon,
  SearchIcon,
  PencilIcon,
  XIcon,
} from 'lucide-react';
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
} from '@/components/ai-elements/task';
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
import { cn } from '@/lib/utils';
import { getToolDisplayName, type ToolPartLike } from './toolName';
import { normalizeToolState } from './toolState';
import { extractPermissionOptions, type PermissionOutcome } from './permission-utils';

export type ToolInvocationPart = ToolPartLike & {
  state?: string;
  result?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: NonNullable<ConfirmationProps['approval']>;
  toolCallId?: string;
};

interface SubAgentRendererProps {
  toolPart: ToolInvocationPart;
  childParts: ToolInvocationPart[];
  messageId: string;
  partIndex: number;
  onPermissionDecide: (id: string, outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => void;
}

function getTaskDescription(toolPart: ToolInvocationPart, intl: IntlShape): string {
  const rawInput = (toolPart.args || toolPart.input || {}) as {
    description?: string;
    prompt?: string;
    subagent_type?: string;
  };
  if (rawInput.description) return rawInput.description;
  if (rawInput.subagent_type) return intl.formatMessage({ id: 'editor.subagent.runningType', defaultMessage: 'Running {type} agent' }, { type: rawInput.subagent_type });
  return intl.formatMessage({ id: 'editor.subagent.running', defaultMessage: 'Running agent...' });
}

function getChildIcon(toolName: string) {
  switch (toolName.toLowerCase()) {
    case 'bash':
      return <TerminalIcon className="size-3.5 shrink-0" />;
    case 'read':
      return <FileTextIcon className="size-3.5 shrink-0" />;
    case 'grep':
    case 'glob':
      return <SearchIcon className="size-3.5 shrink-0" />;
    case 'edit':
    case 'write':
      return <PencilIcon className="size-3.5 shrink-0" />;
    default:
      return null;
  }
}

function getChildLabel(childPart: ToolInvocationPart, intl: IntlShape): React.ReactNode {
  const toolName = getToolDisplayName(childPart);
  const normalizedToolName = toolName.toLowerCase();
  const rawInput = (childPart.args || childPart.input || {}) as Record<string, unknown>;
  const filePath =
    typeof rawInput.file_path === 'string'
      ? rawInput.file_path
      : typeof rawInput.filePath === 'string'
        ? rawInput.filePath
        : undefined;
  const pattern =
    typeof rawInput.pattern === 'string'
      ? rawInput.pattern
      : typeof rawInput.query === 'string'
        ? rawInput.query
        : undefined;

  switch (normalizedToolName) {
    case 'bash': {
      const cmd =
        typeof rawInput.command === 'string'
          ? rawInput.command
          : typeof rawInput.cmd === 'string'
            ? rawInput.cmd
            : undefined;
      const desc = typeof rawInput.description === 'string' ? rawInput.description : undefined;
      return (
        <span className="inline-flex max-w-full min-w-0 items-center gap-1 whitespace-nowrap">
          <span className="shrink-0">{desc || intl.formatMessage({ id: 'editor.subagent.runningCommand', defaultMessage: 'Running command' })}</span>
          {cmd && (
            <span className="min-w-0 overflow-hidden">
              <TaskItemFile>
                <code className="block max-w-[200px] truncate whitespace-nowrap">{cmd}</code>
              </TaskItemFile>
            </span>
          )}
        </span>
      );
    }
    case 'read': {
      const fileName = filePath?.split('/').pop();
      return (
        <span className="inline-flex items-center gap-1">
          {intl.formatMessage({ id: 'editor.subagent.read', defaultMessage: 'Read' })}{fileName && <TaskItemFile filePath={filePath}>{fileName}</TaskItemFile>}
        </span>
      );
    }
    case 'grep': {
      return pattern
        ? intl.formatMessage({ id: 'editor.subagent.searchingPattern', defaultMessage: 'Searching "{pattern}"' }, { pattern })
        : intl.formatMessage({ id: 'editor.subagent.searching', defaultMessage: 'Searching' });
    }
    case 'glob': {
      return pattern
        ? intl.formatMessage({ id: 'editor.subagent.findingPattern', defaultMessage: 'Finding "{pattern}"' }, { pattern })
        : intl.formatMessage({ id: 'editor.subagent.finding', defaultMessage: 'Finding files' });
    }
    case 'edit':
    case 'write': {
      const fileName = filePath?.split('/').pop();
      return (
        <span className="inline-flex items-center gap-1">
          {normalizedToolName === 'edit'
            ? intl.formatMessage({ id: 'editor.subagent.editing', defaultMessage: 'Editing' })
            : intl.formatMessage({ id: 'editor.subagent.writing', defaultMessage: 'Writing' })}
          {fileName && <TaskItemFile filePath={filePath}>{fileName}</TaskItemFile>}
        </span>
      );
    }
    default:
      return toolName;
  }
}

function ChildStateIcon({ state }: { state: string }) {
  const normalized = normalizeToolState(state);
  if (normalized === 'input-streaming') {
    return <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
  }
  if (normalized === 'output-available') {
    return <CheckIcon className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />;
  }
  if (normalized === 'output-error' || normalized === 'output-denied') {
    return <XIcon className="size-3.5 shrink-0 text-destructive" />;
  }
  return null;
}

function ChildApproval({
  childPart,
  onPermissionDecide,
}: {
  childPart: ToolInvocationPart;
  onPermissionDecide: (id: string, outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => void;
}) {
  const state = normalizeToolState(childPart.state);
  if (state !== 'approval-requested') return null;

  const rawInput = (childPart.args || childPart.input || {}) as Record<string, unknown>;
  const { options } = extractPermissionOptions(rawInput);
  const approvalId = childPart.approval?.id ?? childPart.toolCallId;
  const approval: ConfirmationProps['approval'] =
    childPart.approval ?? (approvalId ? { id: approvalId } : undefined);

  const handleDecide = (outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => {
    if (!approvalId) return;
    onPermissionDecide(approvalId, outcome, updatedInput);
  };

  return (
    <Confirmation approval={approval} state={state}>
      <ConfirmationTitle>
        <ConfirmationRequest><FormattedMessage id="editor.confirm.requested" defaultMessage="Permission requested" /></ConfirmationRequest>
        <ConfirmationAccepted>
          <CheckIcon className="size-3.5 text-green-600 dark:text-green-400" />
          <span><FormattedMessage id="editor.confirm.accepted" defaultMessage="Accepted" /></span>
        </ConfirmationAccepted>
        <ConfirmationRejected>
          <XIcon className="size-3.5 text-destructive" />
          <span><FormattedMessage id="editor.confirm.rejected" defaultMessage="Rejected" /></span>
        </ConfirmationRejected>
      </ConfirmationTitle>
      <ConfirmationActions>
        {options.filter(o => o.tone === 'reject').map((opt, i) => (
          <ConfirmationAction
            key={`reject-${i}`}
            tone="reject"
            variant="outline"
            onClick={() => handleDecide(opt.outcome, opt.updatedInput)}
          >
            {opt.label}
          </ConfirmationAction>
        ))}
        {options.filter(o => o.tone === 'allow').map((opt, i) => (
          <ConfirmationAction
            key={`allow-${i}`}
            tone="allow"
            variant="default"
            onClick={() => handleDecide(opt.outcome, opt.updatedInput)}
          >
            {opt.label}
          </ConfirmationAction>
        ))}
      </ConfirmationActions>
    </Confirmation>
  );
}

function ChildToolDetail({ child }: { child: ToolInvocationPart }) {
  const rawInput = (child.args || child.input || {}) as Record<string, unknown>;
  const { displayInput } = extractPermissionOptions(rawInput);
  const output = child.result ?? child.output;
  const hasOutput = output !== undefined && output !== null;

  return (
    <div className="mt-1 rounded-md border border-transparent bg-transparent">
      <ToolInput input={displayInput} />
      {(hasOutput || child.errorText) && <ToolOutput output={output} errorText={child.errorText} />}
    </div>
  );
}

export function SubAgentRenderer({
  toolPart,
  childParts,
  messageId,
  partIndex,
  onPermissionDecide,
}: SubAgentRendererProps) {
  const intl = useIntl();
  const parentState = normalizeToolState(toolPart.state);
  const title = getTaskDescription(toolPart, intl);
  const isStreaming =
    parentState === 'input-streaming' || parentState === 'input-available';
  const isDone = parentState === 'output-available';
  const isError = parentState === 'output-error' || parentState === 'output-denied';

  // A nested step waiting for permission is rendered inside the collapsible, so a
  // collapsed card would hide it. Force the card open while any child is
  // `approval-requested`; otherwise honor the user's manual open/close choice.
  const hasPendingApproval = childParts.some(
    (child) => normalizeToolState(child.state) === 'approval-requested',
  );
  const [userOpen, setUserOpen] = useState(false);
  const open = userOpen || hasPendingApproval;

  return (
    <Task
      key={`${messageId}-${partIndex}`}
      open={open}
      onOpenChange={setUserOpen}
      className="w-full"
    >
      <CollapsibleTrigger asChild className="group">
        <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
          <BotIcon className={cn(
            'size-4 shrink-0',
            isStreaming && !isDone && 'text-blue-500 animate-pulse',
            isDone && 'text-green-600 dark:text-green-400',
            isError && 'text-destructive',
          )} />
          <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-xs"><FormattedMessage id="editor.subagent.agentBadge" defaultMessage="Agent" /></span>
          <p className="text-sm">{title}</p>
          {childParts.length > 0 && (
            <span className="text-xs text-muted-foreground/60">
              <FormattedMessage id="editor.subagent.steps" defaultMessage="{count, plural, one {# step} other {# steps}}" values={{ count: childParts.length }} />
            </span>
          )}
          {hasPendingApproval && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700 text-xs dark:bg-amber-500/15 dark:text-amber-400">
              <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
              <FormattedMessage id="editor.subagent.needsApproval" defaultMessage="Needs approval" />
            </span>
          )}
          <ChevronDownIcon className="ml-auto size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        </div>
      </CollapsibleTrigger>
      <TaskContent>
        {childParts.length === 0 && isStreaming && (
          <TaskItem className="flex items-center gap-2">
            <LoaderIcon className="size-3.5 animate-spin" />
            <span><FormattedMessage id="editor.subagent.starting" defaultMessage="Starting..." /></span>
          </TaskItem>
        )}
        <SubAgentChildList childParts={childParts} onPermissionDecide={onPermissionDecide} />
      </TaskContent>
    </Task>
  );
}

/**
 * The expandable list of a sub-agent's tool steps — each step collapsible, with its detail
 * and an inline approval prompt when the step is `approval-requested`. Shared by
 * SubAgentRenderer and WorkflowToolRenderer (workflow sub-agents nest their steps too).
 */
export function SubAgentChildList({
  childParts,
  onPermissionDecide,
}: {
  childParts: ToolInvocationPart[];
  onPermissionDecide: (id: string, outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => void;
}) {
  const intl = useIntl();
  const [expandedChildren, setExpandedChildren] = useState<Set<string>>(new Set());

  const toggleChild = (id: string) => {
    setExpandedChildren((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <>
      {childParts.map((child, i) => {
        const toolName = getToolDisplayName(child);
        const icon = getChildIcon(toolName);
        const label = getChildLabel(child, intl);
        const childState = normalizeToolState(child.state);
        const childId = child.toolCallId ?? `child-${i}`;
        const isExpanded = expandedChildren.has(childId);

        return (
          <Collapsible
            key={childId}
            open={isExpanded}
            onOpenChange={() => toggleChild(childId)}
          >
            <CollapsibleTrigger asChild>
              <TaskItem className="flex cursor-pointer items-center gap-2 transition-colors hover:text-foreground">
                <ChildStateIcon state={child.state ?? 'input-available'} />
                {icon}
                <span className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground/70">
                  {toolName}
                </span>
                {label}
                <ChevronDownIcon
                  className={cn(
                    'ml-auto size-3.5 shrink-0 text-muted-foreground/50 transition-transform',
                    isExpanded && 'rotate-180'
                  )}
                />
              </TaskItem>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ChildToolDetail child={child} />
            </CollapsibleContent>
            {childState === 'approval-requested' && (
              <div className="mt-1 ml-5">
                <ChildApproval
                  childPart={child}
                  onPermissionDecide={onPermissionDecide}
                />
              </div>
            )}
          </Collapsible>
        );
      })}
    </>
  );
}
