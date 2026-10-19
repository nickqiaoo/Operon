import { useState, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { ChevronDownIcon, Code2Icon, FileCode2 } from 'lucide-react';
import type { BundledLanguage } from 'shiki';
import { CollapsibleTrigger, Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { Task, TaskContent } from '@/components/ai-elements/task';
import { CodeBlock, CodeBlockCopyButton, CodeBlockHeader, CodeBlockFilename } from '@/components/ai-elements/code-block';
import { ToolOutput } from '@/components/ai-elements/tool';
import type { ToolPart } from '@/components/ai-elements/tool';
import { cn } from '@/lib/utils';
import { isCompactEligible } from './compact-tool/isCompactEligible';
import type { ToolPartLike } from './toolName';
import { normalizeToolState } from './toolState';

type ProgramPart = ToolPartLike & {
  state?: string;
  toolCallId?: string;
  output?: ToolPart['output'];
  result?: ToolPart['output'];
  errorText?: string;
};

interface CodeProgramRendererProps<TChild extends ProgramPart> {
  toolPart: ProgramPart;
  /** The tool calls the program made, in order (parts tagged with its call id). */
  childParts: TChild[];
  /** Renders one nested call the way the message would render it on its own. */
  renderChild: (child: TChild) => ReactNode;
}

/**
 * A Code Mode program (`RunCode`, OpenCode's `execute`) and the tool calls it made.
 *
 * Calls that would get a card or need an answer on their own — an external agent run, a created
 * schedule or task, a pending approval — stay visible under the header: folding them away would
 * hide exactly what the user has to see or do. Routine calls, the source and the program's
 * result fold into the body, closed by default (the header counts the calls).
 */
export function CodeProgramRenderer<TChild extends ProgramPart>({ toolPart, childParts, renderChild }: CodeProgramRendererProps<TChild>) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);

  const state = normalizeToolState(toolPart.state);
  const running = state === 'input-streaming' || state === 'input-available';
  const failed = state === 'output-error' || state === 'output-denied';
  const done = state === 'output-available';
  const input = (toolPart.args ?? toolPart.input ?? {}) as { code?: unknown; description?: unknown };
  const code = typeof input.code === 'string' ? input.code : '';
  const title = typeof input.description === 'string' && input.description.trim()
    ? input.description
    : intl.formatMessage({ id: 'editor.codeProgram.untitled', defaultMessage: 'Run a program' });

  const standsOut = (child: TChild) =>
    normalizeToolState(child.state) === 'approval-requested' || !isCompactEligible(child);
  const prominent = childParts.filter(standsOut);
  const routine = childParts.filter((child) => !standsOut(child));
  const needsApproval = childParts.some((child) => normalizeToolState(child.state) === 'approval-requested');
  const output = toolPart.result ?? toolPart.output;
  const codeLines = code ? code.split('\n').length : 0;

  return (
    <Task open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger asChild className="group">
        <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
          <Code2Icon
            className={cn(
              'size-4 shrink-0',
              running && 'text-status-info animate-pulse',
              done && 'text-status-ok',
              failed && 'text-destructive',
            )}
          />
          <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-xs">
            <FormattedMessage id="editor.codeProgram.badge" defaultMessage="Program" />
          </span>
          <p className="min-w-0 truncate text-sm">{title}</p>
          {childParts.length > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground/60">
              <FormattedMessage
                id="editor.codeProgram.calls"
                defaultMessage="{count, plural, one {# call} other {# calls}}"
                values={{ count: childParts.length }}
              />
            </span>
          )}
          {needsApproval && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-status-warn/10 px-1.5 py-0.5 font-medium text-status-warn text-xs">
              <span className="size-1.5 rounded-full bg-accent-warm animate-pulse" />
              <FormattedMessage id="editor.codeProgram.needsApproval" defaultMessage="Needs approval" />
            </span>
          )}
          <ChevronDownIcon className="ml-auto size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        </div>
      </CollapsibleTrigger>

      {prominent.length > 0 && (
        <div className="mt-2 space-y-2 border-muted border-l-2 pl-4">
          {prominent.map((child, i) => (
            <div key={child.toolCallId ?? `prominent-${i}`}>{renderChild(child)}</div>
          ))}
        </div>
      )}

      <TaskContent>
        {code && (
          <Collapsible open={codeOpen} onOpenChange={setCodeOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <FileCode2 className="size-3.5 shrink-0" />
                <span>
                  {codeOpen
                    ? <FormattedMessage id="editor.codeProgram.hideCode" defaultMessage="Hide code" />
                    : <FormattedMessage id="editor.codeProgram.viewCode" defaultMessage="View code" />}
                  <span className="text-muted-foreground/50">
                    {' '}
                    <FormattedMessage
                      id="editor.codeProgram.lines"
                      defaultMessage="({count, plural, one {# line} other {# lines}})"
                      values={{ count: codeLines }}
                    />
                  </span>
                </span>
                <ChevronDownIcon className={cn('ml-auto size-3.5 shrink-0 transition-transform', codeOpen && 'rotate-180')} />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <CodeBlock code={code} language={'typescript' as BundledLanguage}>
                <CodeBlockHeader>
                  <CodeBlockFilename>program.ts</CodeBlockFilename>
                  <CodeBlockCopyButton />
                </CodeBlockHeader>
              </CodeBlock>
            </CollapsibleContent>
          </Collapsible>
        )}
        {routine.map((child, i) => (
          <div key={child.toolCallId ?? `routine-${i}`}>{renderChild(child)}</div>
        ))}
        {(output !== undefined && output !== null) || toolPart.errorText ? (
          <ToolOutput
            output={output}
            errorText={toolPart.errorText}
            className="p-0 pt-1 [&_h4]:hidden [&_.max-h-80]:max-h-40 [&_[data-slot=scroll-area-viewport]]:!max-h-40"
          />
        ) : null}
      </TaskContent>
    </Task>
  );
}
