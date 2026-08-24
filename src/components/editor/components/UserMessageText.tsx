import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { FormattedMessage } from 'react-intl';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { openExternalUrl } from '@/lib/open-external';
import { cn } from '@/lib/utils';

/**
 * Renders what the user typed, verbatim — no markdown. The composer is a plain
 * textarea, so a leading `#` is a `#`, not a heading, and `**x**` keeps its
 * asterisks. Bare URLs still become clickable: that adds an affordance without
 * rewriting any character the user typed.
 *
 * Long messages collapse so a pasted file doesn't push the assistant's reply off
 * screen.
 */

/** Collapse past this rendered height (px) — roughly 16 lines. */
const COLLAPSED_MAX_HEIGHT = 320;
/** Slack so we never collapse to hide just a line or two. */
const COLLAPSE_SLACK = 48;
const FADE_HEIGHT = '3rem';

const URL_PATTERN = /https?:\/\/[^\s<>{}|\\^`"']+/g;

/**
 * Trailing punctuation almost always ends the sentence rather than the URL.
 * A closing paren is kept when it pairs with one inside the URL, so links like
 * `/wiki/Foo_(bar)` survive.
 */
function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1];
    if ('.,;:!?\'"'.includes(char)) {
      end -= 1;
      continue;
    }
    if (char === ')' || char === ']') {
      const open = char === ')' ? '(' : '[';
      const slice = url.slice(0, end);
      let depth = 0;
      for (const c of slice) {
        if (c === open) depth += 1;
        else if (c === char) depth -= 1;
      }
      if (depth < 0) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

function PlainTextLink({ href }: { href: string }) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      openExternalUrl(href);
    },
    [href]
  );

  return (
    <a
      href={href}
      onClick={handleClick}
      className="underline underline-offset-2 hover:opacity-80"
    >
      {href}
    </a>
  );
}

/** Splits text into literal runs and clickable links. Nothing else is parsed. */
function linkify(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const url = trimUrlTail(match[0]);
    if (!url) {
      URL_PATTERN.lastIndex = match.index + match[0].length;
      continue;
    }
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    nodes.push(<PlainTextLink key={match.index} href={url} />);
    cursor = match.index + url.length;
    URL_PATTERN.lastIndex = cursor;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

interface UserMessageTextProps {
  text: string;
  className?: string;
}

export function UserMessageText({ text, className }: UserMessageTextProps) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;

    // scrollHeight reports the full content height even while clamped, so this
    // stays correct in the collapsed state.
    const measure = () => {
      setOverflowing(element.scrollHeight > COLLAPSED_MAX_HEIGHT + COLLAPSE_SLACK);
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    // Re-measure on width changes — a narrower pane wraps into more lines.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  const collapsed = overflowing && !expanded;
  const fade = `linear-gradient(to bottom, #000 calc(100% - ${FADE_HEIGHT}), transparent)`;

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <div
        ref={bodyRef}
        className="whitespace-pre-wrap break-words text-[0.9rem] leading-relaxed"
        style={
          collapsed
            ? {
                maxHeight: COLLAPSED_MAX_HEIGHT,
                overflow: 'hidden',
                // A mask rather than a gradient overlay, so the fade works on
                // every bubble background (default, steer tint, light, dark).
                maskImage: fade,
                WebkitMaskImage: fade,
              }
            : undefined
        }
      >
        {linkify(text)}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          // Opacity rather than a text color: the bubble's foreground differs
          // between a normal message and a steer, and this inherits both.
          className="mt-1.5 inline-flex items-center gap-1.5 self-start text-xs opacity-60 hover:opacity-100 transition-opacity"
        >
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {expanded ? (
            <FormattedMessage id="editor.msg.showLess" defaultMessage="Show less" />
          ) : (
            <FormattedMessage id="editor.msg.showMore" defaultMessage="Show more" />
          )}
        </button>
      )}
    </div>
  );
}
