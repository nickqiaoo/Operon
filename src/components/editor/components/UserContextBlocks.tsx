import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import {
  ChevronDownIcon,
  ClipboardIcon,
  FileTextIcon,
  MessageSquareTextIcon,
  MousePointerClickIcon,
  TextQuoteIcon,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';
import { describeContextBlock, type ContextBlock, type ContextBlockKind } from '@/lib/context-blocks';
import { cn } from '@/lib/utils';

/**
 * The context a user sent along with a prompt — selected text, a line comment,
 * a browser annotation, a paste — rendered as compact cards at the top of the
 * bubble instead of the raw `[File: …]` markup the model receives.
 *
 * Closed by default: the card names where the quote came from, and the quote
 * itself is one click away. The prompt underneath stays the thing you read.
 */

const ICONS: Record<ContextBlockKind, typeof TextQuoteIcon> = {
  'selected-text': TextQuoteIcon,
  'line-comment': MessageSquareTextIcon,
  annotation: MousePointerClickIcon,
  'pasted-text': ClipboardIcon,
  file: FileTextIcon,
};

function BlockLabel({ kind }: { kind: ContextBlockKind }) {
  switch (kind) {
    case 'selected-text':
      return <FormattedMessage id="editor.context.selectedText" defaultMessage="Selected text" />;
    case 'line-comment':
      return <FormattedMessage id="editor.context.lineComment" defaultMessage="Line comment" />;
    case 'annotation':
      return <FormattedMessage id="editor.context.annotation" defaultMessage="Annotation" />;
    case 'pasted-text':
      return <FormattedMessage id="editor.context.pastedText" defaultMessage="Pasted text" />;
    case 'file':
      return <FormattedMessage id="editor.context.file" defaultMessage="File" />;
  }
}

/** First non-empty line, unquoted, for the collapsed header of a location-less block. */
function firstLine(content: string): string {
  const line = content
    .split('\n')
    .map((l) => l.replace(/^>\s?/, '').trim())
    .find((l) => l.length > 0);
  return line ?? '';
}

function ContextBlockCard({ block }: { block: ContextBlock }) {
  const [open, setOpen] = useState(false);
  const view = describeContextBlock(block);
  const Icon = ICONS[view.kind];
  const detail = view.location ?? firstLine(view.content);
  const hasBody = view.content.trim().length > 0;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      // Sits on the user bubble (bg-secondary), so it steps back toward the
      // canvas colour to read as an inset rather than another bubble.
      className="w-full min-w-0 rounded-lg border border-border/50 bg-background/60 dark:border-border/35"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          disabled={!hasBody}
          className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs disabled:cursor-default"
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium">
            <BlockLabel kind={view.kind} />
          </span>
          {detail && (
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={detail}>
              {detail}
            </span>
          )}
          {hasBody && (
            <ChevronDownIcon
              className={cn(
                'ml-auto size-3.5 shrink-0 text-muted-foreground/60 transition-transform',
                open && 'rotate-180',
              )}
            />
          )}
        </button>
      </CollapsibleTrigger>
      {hasBody && (
        <CollapsibleContent className="max-h-72 overflow-auto border-t border-border/40 px-3 py-2">
          {view.markdown ? (
            <MarkdownRenderer content={view.content} className="text-xs" />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{view.content}</pre>
          )}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

export function UserContextBlocks({ blocks, className }: { blocks: ContextBlock[]; className?: string }) {
  if (blocks.length === 0) return null;
  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-1.5', className)}>
      {blocks.map((block, index) => (
        <ContextBlockCard key={`${block.filename}-${index}`} block={block} />
      ))}
    </div>
  );
}
