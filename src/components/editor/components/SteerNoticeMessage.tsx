import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import {
  ChevronDownIcon,
  CheckIcon,
  XIcon,
  TerminalIcon,
  PuzzleIcon,
  InboxIcon,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/**
 * Events the agent runtime steers into the conversation on its own.
 *
 * The framework delivers them as user-role messages because that is the only way text
 * reaches the model mid-turn — but nobody typed them, and it says so itself: every one
 * carries a `[system: automated event, NOT a message from the user...]` stamp aimed at
 * stopping the model from reading them as approval. Painting them as user bubbles
 * contradicts that stamp on screen: the user sees messages they never sent, which is
 * exactly the confusion the stamp exists to prevent.
 *
 * So they get a quiet system notice instead. Three tags come through this path (see
 * `renderSteerText` in agents-core/src/loop/steer.ts):
 *
 *   <background-task-done taskId=… toolCallId=…>   a background task settled
 *   <extension-message from=… …>                   an extension spoke
 *   <external-message source=… deliveryId=… …>     another party's text, verbatim
 *
 * `user` / `user_follow_up` origins render as bare text and never reach here — those
 * really are the user talking.
 */

type SteerKind = 'background' | 'extension' | 'external';

interface SteerNotice {
  readonly kind: SteerKind;
  /** Task id / extension id / source — whatever names the origin. */
  readonly origin: string;
  /** First line of the body: the human-readable outcome. */
  readonly headline: string;
  /** Everything after the headline, minus instructions written for the model. */
  readonly detail: string;
  readonly failed: boolean;
}

const TAGS: Record<SteerKind, string> = {
  background: 'background-task-done',
  extension: 'extension-message',
  external: 'external-message',
};

/** The stamp `renderSteerText` prepends. It is guidance for the model, noise for a reader. */
const SYSTEM_STAMP = /^\[system:[\s\S]*?\]\s*/;

/**
 * Lines addressed to the model, not to the user: they name the tool call that would fetch
 * the rest. The user has the log path right above and a UI to click, so they are dropped.
 */
const MODEL_INSTRUCTION = /^(Read (its output|the full answer) with BackgroundOutput\()/;

/**
 * A task that ended badly. `completed` is the only clean terminal status; the rest
 * (`failed`, `timed_out`, `killed`, `lost`, `paused`) all mean it did not finish its job.
 * Matched on the headline that `buildTerminalSummary` writes — `"<description> <status>
 * (exit code N)."` — rather than on a status field, because the tag carries prose only.
 */
const FAILURE = /\b(failed|timed out|was killed|lost|paused)\b/i;

function attr(tag: string, name: string, text: string): string | undefined {
  return new RegExp(`<${tag}[^>]*\\b${name}="([^"]*)"`).exec(text)?.[1];
}

export function parseSteerNotice(text: string): SteerNotice | undefined {
  const kind = (Object.keys(TAGS) as SteerKind[]).find((k) => text.includes(`<${TAGS[k]}`));
  if (!kind) return undefined;
  const tag = TAGS[kind];

  const inner = new RegExp(`<${tag}[^>]*>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(text)?.[1] ?? '';
  const body = inner.replace(SYSTEM_STAMP, '').trim();
  const lines = body.split('\n');
  const headline = lines[0]?.trim() ?? '';
  const detail = lines
    .slice(1)
    .filter((line) => !MODEL_INSTRUCTION.test(line.trim()))
    .join('\n')
    .trim();

  const origin =
    (kind === 'background'
      ? attr(tag, 'taskId', text)
      : kind === 'extension'
        ? attr(tag, 'from', text)
        : (attr(tag, 'actor', text) ?? attr(tag, 'source', text))) ?? '';

  return { kind, origin, headline, detail, failed: kind === 'background' && FAILURE.test(headline) };
}

export function isSteerNoticeMessage(text: string): boolean {
  return (Object.keys(TAGS) as SteerKind[]).some((k) => text.includes(`<${TAGS[k]}`));
}

const ICONS: Record<SteerKind, typeof TerminalIcon> = {
  background: TerminalIcon,
  extension: PuzzleIcon,
  external: InboxIcon,
};

export function SteerNoticeMessage({ notice }: { notice: SteerNotice }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[notice.kind];
  const expandable = notice.detail.length > 0;

  const label = (
    <span className="truncate text-xs text-muted-foreground">
      {notice.headline || notice.origin}
    </span>
  );

  const header = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      {notice.kind === 'background' ? (
        notice.failed ? (
          <XIcon className="h-3.5 w-3.5 shrink-0 text-status-error" />
        ) : (
          <CheckIcon className="h-3.5 w-3.5 shrink-0 text-status-ok" />
        )
      ) : null}
      {label}
      {expandable && (
        <ChevronDownIcon
          className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform',
            open && 'rotate-180',
          )}
        />
      )}
    </>
  );

  if (!expandable) {
    return (
      <div className="mt-1 flex items-center gap-2 rounded-lg border border-border/40 bg-muted/10 px-3 py-2">
        {header}
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1 rounded-lg border border-border/40 bg-muted/10">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left">
          {header}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border/40 px-3 py-2">
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
          {notice.detail}
        </pre>
        <div className="mt-2 text-[11px] text-muted-foreground/60">
          <FormattedMessage
            id="editor.steerNotice.automated"
            defaultMessage="Automated event — not a message you sent."
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
