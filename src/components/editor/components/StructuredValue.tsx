import { fileCitationsToText } from '@/lib/file-citation';
import type { ReactNode } from 'react';
import { FormattedMessage } from 'react-intl';
import { humanizeKey, splitTrailingJson } from '@shared/json-reply';
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';
import { cn } from '@/lib/utils';

/**
 * A JSON value drawn as what it means rather than as its source.
 *
 * Most spec roles answer in JSON (a verdict and its issues, a ticket list, a
 * review's evidence), and the panel used to print that reply as one long string
 * of braces and escaped newlines. The shapes are known but many, so this reads
 * any of them: fields become labelled rows, lists of objects become small
 * cards, long text is rendered as markdown, and the few words that carry a
 * verdict (pass/fail, severity) are coloured like the rest of the app's status.
 */

/** Fields whose value is a verdict, drawn as a tinted chip. */
const BADGE_KEYS = new Set(['verdict', 'severity', 'result', 'state', 'status']);
/** Fields that name an item, drawn as its heading. */
const TITLE_KEYS = ['title', 'key', 'term', 'question', 'criterion', 'slug', 'label', 'name'];
/** A string this long, or with a line break, is prose and gets markdown. */
const PROSE_CHARS = 120;
/** Nesting deeper than this is shown as JSON — real replies never get here. */
const MAX_DEPTH = 4;

function badgeTone(value: string): string {
  const v = value.toLowerCase();
  if (['pass', 'passed', 'ok', 'done', 'converged', 'completed', 'merged'].includes(v)) {
    return 'bg-status-ok/10 text-status-ok';
  }
  if (['fail', 'failed', 'critical', 'changes', 'error', 'blocked', 'diverged'].includes(v)) {
    return 'bg-status-error/10 text-status-error';
  }
  if (['important', 'warning', 'not_run', 'synthesized'].includes(v)) return 'bg-status-warn/10 text-status-warn';
  return 'bg-muted text-muted-foreground';
}

function Badge({ value }: { value: string }) {
  return (
    <span className={cn('rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide', badgeTone(value))}>
      {value.replace(/_/g, ' ')}
    </span>
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  return value == null || (typeof value === 'string' && !value.trim());
}

function Scalar({ value, fieldKey }: { value: unknown; fieldKey?: string }) {
  if (typeof value === 'string') {
    if (fieldKey && BADGE_KEYS.has(fieldKey) && value.length <= 24) return <Badge value={value} />;
    if (value.length > PROSE_CHARS || value.includes('\n') || value.includes('【F:')) {
      return <MarkdownRenderer content={value} className="text-xs" />;
    }
    return <span className="whitespace-pre-wrap break-words">{value}</span>;
  }
  return <span className="font-mono">{String(value)}</span>;
}

function None() {
  return (
    <span className="text-muted-foreground/60">
      <FormattedMessage id="editor.structured.none" defaultMessage="none" />
    </span>
  );
}

/** One list entry that is itself an object: its name and verdicts on top, the rest below. */
function ItemCard({ item, depth }: { item: Record<string, unknown>; depth: number }) {
  const titleKey = TITLE_KEYS.find((k) => typeof item[k] === 'string' && (item[k] as string).trim());
  const badges = Object.entries(item).filter(
    ([k, v]) => BADGE_KEYS.has(k) && typeof v === 'string' && v.length <= 24,
  );
  const rest = Object.fromEntries(
    Object.entries(item).filter(([k]) => k !== titleKey && !badges.some(([b]) => b === k)),
  );
  return (
    <div className="space-y-1 rounded-md border border-border/40 bg-background/40 px-2 py-1.5">
      {(titleKey || badges.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {badges.map(([k, v]) => (
            <Badge key={k} value={v as string} />
          ))}
          {titleKey && <span className="font-medium text-foreground/90">{fileCitationsToText(item[titleKey] as string)}</span>}
        </div>
      )}
      {Object.keys(rest).length > 0 && <Fields value={rest} depth={depth + 1} />}
    </div>
  );
}

function ListValue({ value, depth }: { value: unknown[]; depth: number }) {
  if (value.length === 0) return <None />;
  if (value.every((v) => !isPlainObject(v) && !Array.isArray(v))) {
    return (
      <ul className="list-disc space-y-0.5 pl-4">
        {value.map((v, i) => (
          <li key={i}>
            <Scalar value={v} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="space-y-1">
      {value.map((v, i) =>
        isPlainObject(v) ? <ItemCard key={i} item={v} depth={depth} /> : <AnyValue key={i} value={v} depth={depth + 1} />,
      )}
    </div>
  );
}

/** An object's fields: short ones on one line with their label, the rest under it. */
function Fields({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(value).filter(([, v]) => !isEmpty(v));
  if (entries.length === 0) return <None />;
  return (
    <div className="space-y-1.5">
      {entries.map(([key, v]) => {
        const inline =
          (typeof v === 'string' && v.length <= PROSE_CHARS && !v.includes('\n')) ||
          typeof v === 'number' ||
          typeof v === 'boolean' ||
          (Array.isArray(v) && v.length === 0);
        return inline ? (
          <div key={key} className="flex flex-wrap items-baseline gap-x-2">
            <span className="shrink-0 text-muted-foreground/70">{humanizeKey(key)}</span>
            {Array.isArray(v) ? <None /> : <Scalar value={v} fieldKey={key} />}
          </div>
        ) : (
          <div key={key} className="space-y-0.5">
            <div className="text-muted-foreground/70">
              {humanizeKey(key)}
              {Array.isArray(v) && <span className="tabular-nums text-muted-foreground/50"> · {v.length}</span>}
            </div>
            <AnyValue value={v} depth={depth + 1} fieldKey={key} />
          </div>
        );
      })}
    </div>
  );
}

function AnyValue({ value, depth, fieldKey }: { value: unknown; depth: number; fieldKey?: string }) {
  if (depth > MAX_DEPTH) {
    return <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">{JSON.stringify(value, null, 2)}</pre>;
  }
  if (Array.isArray(value)) return <ListValue value={value} depth={depth} />;
  if (isPlainObject(value)) return <Fields value={value} depth={depth} />;
  if (isEmpty(value)) return <None />;
  return <Scalar value={value} fieldKey={fieldKey} />;
}

export function StructuredValue({ value, className }: { value: unknown; className?: string }) {
  return (
    <div className={cn('text-xs text-foreground/80', className)}>
      <AnyValue value={value} depth={0} />
    </div>
  );
}

/**
 * Text that may be a structured reply: drawn as fields when it is one (any
 * narration before the object kept above it), as-is otherwise via `fallback`.
 */
export function StructuredOrText({
  text,
  fallback,
}: {
  text: string;
  fallback: (text: string) => ReactNode;
}) {
  const structured = splitTrailingJson(text);
  if (!structured) return <>{fallback(text)}</>;
  return (
    <div className="space-y-1.5">
      {structured.lead && fallback(structured.lead)}
      <StructuredValue value={structured.value} />
    </div>
  );
}
