import type { UIMessage } from 'ai';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import { stripContextBlocks } from '@/lib/context-blocks';
import { cn } from '@/lib/utils';
import { isSteerUserMessage } from './steer-message';
import { extractPeerMessage } from '../utils/chatMetadata';

/**
 * The turn rail: one tick per prompt, stacked down the left gutter of the
 * transcript. It answers "where am I, and where were the other questions" in a
 * glance and jumps back to any of them in one click — cheaper than dragging the
 * scrollbar through a long chat looking for a message.
 *
 * Ticks taper in length and fade with distance from the turn you are reading,
 * so the shape of the stack itself tells you your position; hovering the rail
 * levels them out and reveals a preview card for the tick under the cursor.
 */

/** How much of each side of a turn's text the preview card can show. */
const PREVIEW_LIMIT = 220;

export type ChatNavigatorEntry = {
  id: string;
  /** What the user asked, as one line of plain text. */
  title: string;
  /** The start of the answer, for the hover card. */
  preview: string;
};

/** Joins a message's text parts into one whitespace-collapsed line, capped. */
function plainText(message: UIMessage, limit: number): string {
  let out = '';
  for (const part of message.parts ?? []) {
    if (part.type !== 'text') continue;
    out += part.text;
    if (out.length >= limit) break;
  }
  if (message.role === 'user') out = stripContextBlocks(out);
  return out.replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * One entry per rendered prompt, paired with the reply that followed it.
 *
 * Steers are skipped: they render as follow-up chips inside the turn that owns
 * them rather than as their own row, so they have no anchor to jump to.
 */
export function buildChatNavigatorEntries(messages: readonly UIMessage[]): ChatNavigatorEntry[] {
  const entries: ChatNavigatorEntry[] = [];
  let current: ChatNavigatorEntry | undefined;

  for (const message of messages) {
    if (message.role === 'user') {
      if (isSteerUserMessage(message)) continue;
      // A teammate's message starts a real turn, so it earns a row — but the rail is a list
      // of prompts, and reading a teammate's report there as if the user had said it is
      // exactly the confusion the transcript card avoids. Name the sender.
      const peer = extractPeerMessage(message);
      const body = plainText(message, PREVIEW_LIMIT);
      current = { id: message.id, title: peer ? `${peer.from}: ${body}` : body, preview: '' };
      entries.push(current);
      continue;
    }

    if (message.role !== 'assistant') continue;
    // Streaming re-runs this on every token, so stop reading a turn's text once
    // there is enough of it to fill the card.
    if (!current || current.preview.length >= PREVIEW_LIMIT) continue;
    const text = plainText(message, PREVIEW_LIMIT - current.preview.length);
    if (!text) continue;
    current.preview = current.preview ? `${current.preview} ${text}` : text;
  }

  return entries;
}

/** Free space (px) the rail needs to the left of the reading column to appear. */
const RAIL_MIN_SPACE = 38;
/** Distance from the panel's left edge to the rail. */
const RAIL_INSET = 8;
/** Hit-area width of a tick row — the tick itself is shorter. */
const RAIL_WIDTH = 24;
/** Vertical pitch of the stack; also the click target's height. */
const ROW_HEIGHT = 12;
/** A turn becomes "current" once its top passes this far into the viewport. */
const ACTIVE_LINE_OFFSET = 96;
/** Horizontal padding the reading column reserves on each side (`px-4`). */
const CONTENT_PADDING = 16;
/** Tick length by distance from the active turn (last value covers the tail). */
const TICK_WIDTHS = [18, 13, 10, 8];
/** Tick length while the rail is hovered and the stack levels out. */
const TICK_WIDTH_HOVERED = 16;
const TICK_WIDTH_HOVERED_FOCUS = 20;
/** Coalescing window for content resizes, which fire on every streamed frame. */
const MEASURE_DEBOUNCE_MS = 120;
/** Keeps the hover card clear of the transcript's clipped top/bottom edges. */
const CARD_EDGE_MARGIN = 72;

type HoverState = { index: number; top: number };

export const ChatNavigator = memo(function ChatNavigator({
  entries,
}: {
  entries: ChatNavigatorEntry[];
}) {
  const intl = useIntl();
  const { scrollRef, contentRef } = useStickToBottomContext();
  const frameRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  /** Scroll offset of each entry inside the transcript, by entry index. */
  const offsetsRef = useRef<number[]>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const [activeIndex, setActiveIndex] = useState(0);
  const [hover, setHover] = useState<HoverState | null>(null);
  /** Free space left of the reading column; the rail hides when it is too tight. */
  const [gutter, setGutter] = useState(0);

  const updateActive = useCallback(() => {
    const scrollEl = scrollRef.current;
    const offsets = offsetsRef.current;
    if (!scrollEl || offsets.length === 0) return;

    const line = scrollEl.scrollTop + ACTIVE_LINE_OFFSET;
    let next = 0;
    for (let index = 0; index < offsets.length; index += 1) {
      if (offsets[index] <= line) next = index;
    }
    setActiveIndex(next);
  }, [scrollRef]);

  const measure = useCallback(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;

    const scrollRect = scrollEl.getBoundingClientRect();
    const contentRect = contentEl.getBoundingClientRect();
    // The rail may sit inside the column's own padding, so count it as free.
    setGutter(contentRect.left - scrollRect.left + CONTENT_PADDING);

    // One sweep for every anchor rather than a lookup per entry: a long
    // transcript is tens of thousands of nodes, and this reruns while the reply
    // streams.
    const anchors = new Map<string, HTMLElement>();
    const found = contentEl.querySelectorAll<HTMLElement>('[data-message-item-role="user"]');
    for (const anchor of found) {
      const id = anchor.dataset.messageId;
      if (id) anchors.set(id, anchor);
    }

    offsetsRef.current = entriesRef.current.map((entry) => {
      const anchor = anchors.get(entry.id);
      if (!anchor) return Number.POSITIVE_INFINITY;
      return anchor.getBoundingClientRect().top - scrollRect.top + scrollEl.scrollTop;
    });
    updateActive();
  }, [contentRef, scrollRef, updateActive]);

  // Passive, not layout: the refs belong to ConversationContent, a sibling that
  // attaches them later in the same commit.
  //
  // Messages arriving, growing, or collapsing all move the anchors; so does
  // resizing the panel, which is also what decides whether the rail fits.
  // Streaming resizes the content on nearly every frame, so coalesce: an offset
  // that lags a beat costs nothing, since only scrolling reads it.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        measure();
      }, MEASURE_DEBOUNCE_MS);
    });
    observer.observe(scrollEl);
    observer.observe(contentEl);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [contentRef, measure, scrollRef]);

  // A turn appearing (or older history being prepended) shifts every offset
  // below it, and the rail is what the user is about to click — remeasure now
  // rather than waiting for the debounce.
  const entriesSignature = `${entries.length}:${entries[0]?.id ?? ''}`;
  useEffect(() => {
    measure();
  }, [entriesSignature, measure]);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    let frame = 0;
    const handleScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateActive();
      });
    };

    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scrollEl.removeEventListener('scroll', handleScroll);
    };
  }, [scrollRef, updateActive]);

  // Long chats overflow the rail, so keep the active tick in view — without
  // scrollIntoView, which would also scroll the transcript behind it.
  const railVisible = entries.length >= 2 && gutter >= RAIL_MIN_SPACE;
  useEffect(() => {
    const rail = railRef.current;
    const tick = rail?.children[activeIndex];
    if (!rail || !(tick instanceof HTMLElement)) return;

    if (tick.offsetTop < rail.scrollTop) {
      rail.scrollTop = tick.offsetTop;
    } else if (tick.offsetTop + tick.offsetHeight > rail.scrollTop + rail.clientHeight) {
      rail.scrollTop = tick.offsetTop + tick.offsetHeight - rail.clientHeight;
    }
  }, [activeIndex, railVisible]);

  const handleJump = useCallback(
    (index: number) => {
      const scrollEl = scrollRef.current;
      const top = offsetsRef.current[index];
      if (!scrollEl || !Number.isFinite(top)) return;
      scrollEl.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
    },
    [scrollRef],
  );

  const handleEnter = useCallback((index: number, tick: HTMLElement) => {
    const frame = frameRef.current;
    if (!frame) return;
    const tickRect = tick.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const center = tickRect.top + tickRect.height / 2 - frameRect.top;
    setHover({
      index,
      // The transcript clips vertically, so pin the card away from the edges.
      top: Math.min(Math.max(center, CARD_EDGE_MARGIN), frameRect.height - CARD_EDGE_MARGIN),
    });
  }, []);

  if (!railVisible) return null;

  const hovered = hover ? entries[hover.index] : null;

  return (
    <div
      ref={frameRef}
      data-testid="chat-navigator"
      className="pointer-events-none absolute inset-y-0 z-10 flex items-center"
      style={{ left: RAIL_INSET }}
    >
      <nav
        ref={railRef}
        aria-label={intl.formatMessage({
          id: 'editor.chat.navigator.label',
          defaultMessage: 'Conversation turns',
        })}
        className="scrollbar-none pointer-events-auto relative flex max-h-[70%] flex-col items-start overflow-y-auto overflow-x-hidden py-2"
        style={{ width: RAIL_WIDTH }}
        onMouseLeave={() => setHover(null)}
        // The card is positioned from the tick's box, which moves when the rail
        // scrolls under the cursor.
        onScroll={() => setHover(null)}
      >
        {entries.map((entry, index) => {
          const isActive = index === activeIndex;
          const isHovered = hover?.index === index;
          const distance = Math.abs(index - activeIndex);
          const width = hover
            ? isHovered || isActive
              ? TICK_WIDTH_HOVERED_FOCUS
              : TICK_WIDTH_HOVERED
            : TICK_WIDTHS[Math.min(distance, TICK_WIDTHS.length - 1)];

          return (
            <button
              key={entry.id}
              type="button"
              aria-label={entry.title || intl.formatMessage({
                id: 'editor.chat.navigator.untitled',
                defaultMessage: 'Attachment only',
              })}
              aria-current={isActive ? 'true' : undefined}
              className="flex w-full shrink-0 cursor-pointer items-center"
              style={{ height: ROW_HEIGHT }}
              onMouseEnter={(event) => handleEnter(index, event.currentTarget)}
              onFocus={(event) => handleEnter(index, event.currentTarget)}
              onBlur={() => setHover(null)}
              onClick={() => handleJump(index)}
            >
              <span
                className={cn(
                  'rounded-full transition-all duration-200 ease-out',
                  isActive || isHovered
                    ? 'bg-foreground/70'
                    : hover
                      ? 'bg-foreground/30'
                      : distance === 1
                        ? 'bg-foreground/25'
                        : distance === 2
                          ? 'bg-foreground/20'
                          : 'bg-foreground/15',
                )}
                style={{ width, height: isActive ? 3 : 2 }}
              />
            </button>
          );
        })}
      </nav>

      {hovered && (
        <div
          data-testid="chat-navigator-card"
          className="pointer-events-none absolute z-20 w-64 -translate-y-1/2 rounded-xl border border-border/60 bg-popover px-3 py-2.5 shadow-float"
          style={{ left: RAIL_WIDTH + 8, top: hover?.top }}
        >
          <p className="truncate text-xs font-medium text-foreground">
            {hovered.title ||
              intl.formatMessage({
                id: 'editor.chat.navigator.untitled',
                defaultMessage: 'Attachment only',
              })}
          </p>
          {hovered.preview && (
            <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
              {hovered.preview}
            </p>
          )}
        </div>
      )}
    </div>
  );
});
