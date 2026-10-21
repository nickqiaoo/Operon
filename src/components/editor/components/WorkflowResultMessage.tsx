import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { Workflow as WorkflowIcon, ChevronDownIcon, CheckIcon, Layers, XIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';

/**
 * A finished workflow's result, as it lands in the conversation.
 *
 * The node delivers the result by starting a turn with a user-role message (see
 * `services/workflow/completion.ts`) — that is what puts it in front of the model.
 * Rendering it as a user bubble would be a lie though: nobody typed it. So it gets
 * its own quiet, collapsed card, closer to a system notice than to a message.
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
  const [open, setOpen] = useState(false);
  const name = tagValue(text, 'name') ?? 'workflow';
  const status = tagValue(text, 'status') ?? 'completed';
  const result = tagValue(text, 'result');
  const error = tagValue(text, 'error');
  const ok = status === 'completed';
  const body = result ?? error;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mt-1 rounded-xl border border-border/40 bg-muted/10"
    >
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left">
          <WorkflowIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{name}</span>
          {ok ? (
            <span className="flex items-center gap-1 text-xs text-status-ok">
              <CheckIcon className="h-3.5 w-3.5" />
              <FormattedMessage id="editor.workflowResult.completed" defaultMessage="workflow finished" />
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-status-error">
              <XIcon className="h-3.5 w-3.5" />
              <FormattedMessage id="editor.workflowResult.ended" defaultMessage="workflow ended: {status}" values={{ status }} />
            </span>
          )}
          {body && (
            <ChevronDownIcon
              className={cn(
                'ml-auto h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform',
                open && 'rotate-180',
              )}
            />
          )}
        </button>
      </CollapsibleTrigger>
      {body && (
        <CollapsibleContent className="border-t border-border/40 px-4 py-3">
          <MarkdownRenderer content={body} className="text-sm" />
        </CollapsibleContent>
      )}
    </Collapsible>
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
    <div className="mt-1 flex items-start gap-2 px-1 text-xs text-muted-foreground">
      <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="font-mono">#{notice.spec}</span> · {notice.body}
      </span>
    </div>
  );
}
