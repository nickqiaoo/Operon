import { FormattedMessage } from 'react-intl';
import { Workflow as WorkflowIcon } from 'lucide-react';
import { SpecIcon } from '@/components/icons/SpecIcon';
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
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';

/**
 * A finished workflow's result, as it lands in the conversation.
 *
 * The node delivers the result by starting a turn with a user-role message (see
 * `services/workflow/completion.ts`) — that is what puts it in front of the model.
 * Rendering it as a user bubble would be a lie though: nobody typed it. So it is
 * one more step line in the turn (Trace), closed, opening onto the result.
 */

const WORKFLOW_RESULT_TAG = '<workflow-result>';

export function isWorkflowResultMessage(text: string): boolean {
  return text.includes(WORKFLOW_RESULT_TAG);
}

/**
 * A spec's run reporting back (`OperonSpec #N`, see `services/spec`). The spec's
 * own card above it already shows where the spec stands, live, so a second
 * "workflow finished" strip after each stage only repeats it.
 */
export function isSpecWorkflowResult(text: string): boolean {
  return /^OperonSpec #\d+$/.test(tagValue(text, 'name') ?? '');
}

function tagValue(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(text);
  return match?.[1];
}

export function WorkflowResultMessage({ text }: { text: string }) {
  const name = tagValue(text, 'name') ?? 'workflow';
  const status = tagValue(text, 'status') ?? 'completed';
  const result = tagValue(text, 'result');
  const error = tagValue(text, 'error');
  const ok = status === 'completed';
  const body = result ?? error;

  const line = (
    <TraceLine status={ok ? undefined : 'error'}>
      <TraceIcon><WorkflowIcon /></TraceIcon>
      <TraceTitle>{name}</TraceTitle>
      <TraceDescription className={ok ? 'text-status-ok' : 'text-status-error'}>
        {ok ? (
          <FormattedMessage id="editor.workflowResult.completed" defaultMessage="workflow finished" />
        ) : (
          <FormattedMessage id="editor.workflowResult.ended" defaultMessage="workflow ended: {status}" values={{ status }} />
        )}
      </TraceDescription>
    </TraceLine>
  );

  return (
    <Trace className="mt-1">
      {body ? (
        <TraceCollapsible>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="text-foreground">
            <MarkdownRenderer content={body} className="text-sm" />
          </TraceCollapsibleContent>
        </TraceCollapsible>
      ) : (
        line
      )}
    </Trace>
  );
}

/**
 * A spec telling the chat it was started from that it needs the user — a switch
 * the coordinator asks for, a step that failed (see `specNoticeText` on the
 * server). Like a workflow result it reaches the model as a user-role message;
 * here it is one quiet line, since the agent's reply and the bar above the
 * composer carry what to do about it.
 */
export function parseSpecNotice(text: string): { spec: string; body: string } | undefined {
  const match = /<spec-notice spec="(\d+)">\s*([\s\S]*?)\s*<\/spec-notice>/.exec(text);
  return match ? { spec: match[1], body: match[2] } : undefined;
}

export function SpecNoticeMessage({ notice }: { notice: { spec: string; body: string } }) {
  return (
    <Trace className="mt-1">
      <TraceLine className="items-start">
        <TraceIcon className="mt-0.5"><SpecIcon /></TraceIcon>
        {/* Wraps rather than truncating: the notice is the whole message. */}
        <span className="min-w-0">
          <span className="font-mono">#{notice.spec}</span> · {notice.body}
        </span>
      </TraceLine>
    </Trace>
  );
}
