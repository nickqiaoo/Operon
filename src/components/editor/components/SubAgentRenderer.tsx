import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl, type IntlShape } from 'react-intl';
import { BotIcon, CircleDashedIcon } from 'lucide-react';
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
import type { ConfirmationProps } from '@/components/ai-elements/confirmation';
import { CompactToolCall } from './compact-tool/CompactToolCall';
import type { ToolPartLike } from './toolName';
import { normalizeToolState } from './toolState';
import type { PermissionOutcome } from './permission-utils';
import type { SubagentTranscript } from '@shared/background-tasks';
import { api } from '@/lib/api';
import { useBackgroundTask } from '@/stores/chat-background-task-store';
import { useChatDbId } from './chat-db-id-context';

export type ToolInvocationPart = ToolPartLike & {
  state?: string;
  result?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: NonNullable<ConfirmationProps['approval']>;
  toolCallId?: string;
};

type PermissionDecide = (
  id: string,
  outcome: PermissionOutcome,
  updatedInput?: Record<string, unknown>,
) => Promise<boolean> | void;

interface SubAgentRendererProps {
  toolPart: ToolInvocationPart;
  childParts: ToolInvocationPart[];
  messageId: string;
  partIndex: number;
  onPermissionDecide: PermissionDecide;
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

/**
 * A background sub-agent's steps, read from its transcript. Its steps never reach
 * the chat's messages — it keeps working after the turn that launched it has
 * ended — so this is the card's only source for them. Re-read whenever
 * `refreshKey` changes (the agent made another call, or finished).
 */
function useSubagentTranscript(
  chatId: number | undefined,
  toolUseId: string | undefined,
  enabled: boolean,
  refreshKey: string,
): SubagentTranscript | undefined {
  const [transcript, setTranscript] = useState<SubagentTranscript>();
  useEffect(() => {
    if (!enabled || chatId == null || !toolUseId) return;
    let cancelled = false;
    api.aiSubagentTranscript(chatId, toolUseId)
      .then((result) => {
        if (!cancelled && !result.error) setTranscript({ steps: result.steps, finished: result.finished });
      })
      .catch(() => {
        // Not written yet, or the server is gone; the next refresh tries again.
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, toolUseId, enabled, refreshKey]);
  return transcript;
}

export function SubAgentRenderer({
  toolPart,
  childParts,
  messageId,
  partIndex,
  onPermissionDecide,
}: SubAgentRendererProps) {
  const intl = useIntl();
  const chatId = useChatDbId();
  const parentState = normalizeToolState(toolPart.state);
  const title = getTaskDescription(toolPart, intl);

  // A background agent's tool call returns the moment it launches, so the call's
  // own state says "done" while the agent is still working. Its real status comes
  // from the server's task list, or — after a restart, when that is gone — from
  // whether its transcript ends in a final report.
  const rawInput = (toolPart.args || toolPart.input || {}) as { run_in_background?: unknown };
  const task = useBackgroundTask(chatId, toolPart.toolCallId);
  const isBackground = rawInput.run_in_background === true || task != null;

  const [userOpen, setUserOpen] = useState<boolean>();
  const transcript = useSubagentTranscript(
    chatId,
    toolPart.toolCallId,
    // Read while the steps are on screen (opened, or open because it is still
    // running and nobody closed it); collapsed with a live task the header has
    // all it needs; without one, read once for the step count and whether it
    // finished.
    isBackground && (userOpen === true || task == null || (userOpen === undefined && task.status === 'running')),
    `${task?.status ?? ''}:${task?.toolUses ?? ''}`,
  );

  const steps: ToolInvocationPart[] =
    isBackground && transcript
      ? transcript.steps.map((step) => ({ type: 'dynamic-tool', ...step }))
      : childParts;

  // Without a task entry the process that ran it is gone (restart, session
  // rebuilt), so it is not running any more: finished if it wrote its report,
  // otherwise it was cut off and shows neither done nor failed.
  const backgroundRunning = task?.status === 'running';
  const isStreaming = isBackground
    ? backgroundRunning
    : parentState === 'input-streaming' || parentState === 'input-available';
  const isDone = isBackground
    ? task
      ? task.status === 'completed'
      : transcript?.finished === true
    : parentState === 'output-available';
  const isError =
    parentState === 'output-error' ||
    parentState === 'output-denied' ||
    task?.status === 'failed' ||
    task?.status === 'stopped';
  const stepCount = isBackground ? Math.max(task?.toolUses ?? 0, steps.length) : steps.length;
  const progress = backgroundRunning ? task?.summary : undefined;

  // A nested step waiting for permission sits inside the collapsible, so a
  // collapsed line would hide it: keep it open while any step waits. Otherwise
  // it follows the run (open while working, as shadcn's Subagent) until the
  // person opens or closes it.
  const hasPendingApproval = steps.some(
    (child) => normalizeToolState(child.state) === 'approval-requested',
  );
  const running = isStreaming && !isDone;
  const open = hasPendingApproval || (userOpen ?? running);
  // An old background run whose transcript is gone has no steps to show: then it
  // is a plain line, like an empty thought, rather than one that opens on nothing.
  const hasSteps = steps.length > 0 || stepCount > 0 || isStreaming || hasPendingApproval;

  const line = (
    <TraceLine status={running ? 'running' : isError ? 'error' : undefined}>
      <TraceIcon><BotIcon /></TraceIcon>
      <TraceTitle>{title}</TraceTitle>
      {stepCount > 0 && (
        <TraceDescription>
          <FormattedMessage id="editor.subagent.steps" defaultMessage="{count, plural, one {# step} other {# steps}}" values={{ count: stepCount }} />
        </TraceDescription>
      )}
      {isBackground && (
        <TraceDescription>
          <FormattedMessage id="editor.subagent.background" defaultMessage="Background" />
        </TraceDescription>
      )}
      {progress && (
        <TraceDescription className="min-w-0 shrink truncate">{progress}</TraceDescription>
      )}
      {hasPendingApproval && (
        <TraceDescription className="text-status-warn">
          <FormattedMessage id="editor.subagent.needsApproval" defaultMessage="Needs approval" />
        </TraceDescription>
      )}
    </TraceLine>
  );

  if (!hasSteps) {
    return <Trace key={`${messageId}-${partIndex}`}>{line}</Trace>;
  }

  return (
    <Trace key={`${messageId}-${partIndex}`}>
      <TraceCollapsible open={open} onOpenChange={setUserOpen}>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {steps.length === 0 && isStreaming && (
              <TraceLine status="running">
                <TraceIcon><CircleDashedIcon /></TraceIcon>
                <TraceTitle><FormattedMessage id="editor.subagent.starting" defaultMessage="Starting..." /></TraceTitle>
              </TraceLine>
            )}
            <SubAgentChildList childParts={steps} onPermissionDecide={onPermissionDecide} />
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/**
 * A sub-agent's tool steps: each one the same Tool line the main thread draws
 * (CompactToolCall), approvals included. Shared by SubAgentRenderer and
 * WorkflowToolRenderer (workflow sub-agents nest their steps too).
 */
export function SubAgentChildList({
  childParts,
  onPermissionDecide,
}: {
  childParts: ToolInvocationPart[];
  onPermissionDecide: PermissionDecide;
}) {
  const decide = (id: string, outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) =>
    Promise.resolve(onPermissionDecide(id, outcome, updatedInput)).then((accepted) => accepted ?? true);

  return (
    <>
      {childParts.map((child, i) => (
        <CompactToolCall
          key={child.toolCallId ?? `child-${i}`}
          toolPart={child}
          messageId=""
          partIndex={i}
          onPermissionDecide={decide}
        />
      ))}
    </>
  );
}
