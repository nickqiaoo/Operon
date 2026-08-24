import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { Workflow as WorkflowIcon, ChevronDownIcon, CheckIcon, XIcon } from 'lucide-react';
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
