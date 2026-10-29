import { useState, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Code2Icon, FileCode2 } from 'lucide-react';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockHighlightedContent,
  CodeBlockTitle,
} from '@/components/ui/code-block';
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
import { ToolOutput, toolTraceStatus } from '@/components/ai-elements/tool';
import type { ToolPart } from '@/components/ai-elements/tool';
import { standsOutOfProgram } from './compact-tool/isCompactEligible';
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
 * result fold into the body, closed by default (the header counts the calls). Built on Trace like
 * every other step: the nested calls are the same Tool lines the thread draws.
 */
export function CodeProgramRenderer<TChild extends ProgramPart>({ toolPart, childParts, renderChild }: CodeProgramRendererProps<TChild>) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);

  const state = normalizeToolState(toolPart.state);
  const input = (toolPart.args ?? toolPart.input ?? {}) as { code?: unknown; description?: unknown };
  const code = typeof input.code === 'string' ? input.code : '';
  const title = typeof input.description === 'string' && input.description.trim()
    ? input.description
    : intl.formatMessage({ id: 'editor.codeProgram.untitled', defaultMessage: 'Run a program' });

  const prominent = childParts.filter(standsOutOfProgram);
  const routine = childParts.filter((child) => !standsOutOfProgram(child));
  const needsApproval = childParts.some((child) => normalizeToolState(child.state) === 'approval-requested');
  const output = toolPart.result ?? toolPart.output;
  const codeLines = code ? code.split('\n').length : 0;

  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={toolTraceStatus(state)}>
            <TraceIcon><Code2Icon /></TraceIcon>
            <TraceTitle>{title}</TraceTitle>
            {childParts.length > 0 && (
              <TraceDescription>
                <FormattedMessage
                  id="editor.codeProgram.calls"
                  defaultMessage="{count, plural, one {# call} other {# calls}}"
                  values={{ count: childParts.length }}
                />
              </TraceDescription>
            )}
            {needsApproval && (
              <TraceDescription className="text-status-warn">
                <FormattedMessage id="editor.codeProgram.needsApproval" defaultMessage="Needs approval" />
              </TraceDescription>
            )}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {code && (
              <TraceCollapsible open={codeOpen} onOpenChange={setCodeOpen}>
                <TraceCollapsibleTrigger>
                  <TraceLine>
                    <TraceIcon><FileCode2 /></TraceIcon>
                    <TraceTitle><FormattedMessage id="editor.codeProgram.viewCode" defaultMessage="View code" /></TraceTitle>
                    <TraceDescription>
                      <FormattedMessage
                        id="editor.codeProgram.lineCount"
                        defaultMessage="{count, plural, one {# line} other {# lines}}"
                        values={{ count: codeLines }}
                      />
                    </TraceDescription>
                  </TraceLine>
                </TraceCollapsibleTrigger>
                <TraceCollapsibleContent>
                  <CodeBlock size="sm">
                    <CodeBlockHeader>
                      <CodeBlockTitle>program.ts</CodeBlockTitle>
                      <CodeBlockActions>
                        <CodeBlockCopyButton value={code} />
                      </CodeBlockActions>
                    </CodeBlockHeader>
                    <CodeBlockHighlightedContent code={code} language="typescript" className="max-h-96" />
                  </CodeBlock>
                </TraceCollapsibleContent>
              </TraceCollapsible>
            )}
            {routine.map((child, i) => (
              <div key={child.toolCallId ?? `routine-${i}`} className="min-w-0">{renderChild(child)}</div>
            ))}
            {(output !== undefined && output !== null) || toolPart.errorText ? (
              <ToolOutput output={output} errorText={toolPart.errorText} />
            ) : null}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>

      {/* Out of the fold, but indented under the line like its content. */}
      {prominent.length > 0 && (
        <div className="ml-[calc(--spacing(2)-1px)] min-w-0 border-l border-border/50 pl-4 dark:border-border/35">
          <Trace>
            {prominent.map((child, i) => (
              <div key={child.toolCallId ?? `prominent-${i}`} className="min-w-0">{renderChild(child)}</div>
            ))}
          </Trace>
        </div>
      )}
    </Trace>
  );
}
