"use client";

import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  messageScrollerButtonClassName,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { cn } from "@/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import { useReadingScrollAnchor } from "./use-reading-scroll-anchor";
import { useNativeScrollButton } from "@/hooks/useNativeScrollButton";
import {
  createContext, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type ComponentProps, type Ref, type RefObject,
} from "react";

export type ConversationScrollHandle = ReturnType<typeof useMessageScroller>;

/** A row and its distance from the viewport's top edge. */
type ReadingPoint = { messageId: string; offset: number };
/** Where readers left transcripts that unmounted mid-history, by `positionKey`. */
const savedReadingPoints = new Map<string, ReadingPoint>();

/**
 * What moves scroll offsets without the reader: the viewport's size, and the
 * content's padding (insets for chrome floating over the transcript). The
 * primitive observes only the content box, which padding never changes.
 */
function scrollGeometry(viewport: HTMLElement, contentStyle: CSSStyleDeclaration) {
  return `${viewport.clientWidth} ${viewport.clientHeight} ${contentStyle.paddingTop} ${contentStyle.paddingBottom}`;
}

type ConversationRefs = {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  selecting: boolean;
  setSelecting: (selecting: boolean) => void;
  isAtBottom: boolean;
  setIsAtBottom: (atBottom: boolean) => void;
  programmaticScrollRef: RefObject<boolean>;
  positionKey?: string;
  restorePoint: ReadingPoint | null;
};
const ConversationContext = createContext<ConversationRefs | null>(null);

export function useConversationScroll() {
  const refs = useContext(ConversationContext);
  if (!refs) throw new Error("useConversationScroll must be used within Conversation");
  const controls = useMessageScroller();
  const scrollToEnd = useCallback((...args: Parameters<typeof controls.scrollToEnd>) => {
    refs.programmaticScrollRef.current = true;
    return controls.scrollToEnd(...args);
  }, [controls.scrollToEnd, refs.programmaticScrollRef]);
  const scrollToStart = useCallback((...args: Parameters<typeof controls.scrollToStart>) => {
    refs.programmaticScrollRef.current = true;
    return controls.scrollToStart(...args);
  }, [controls.scrollToStart, refs.programmaticScrollRef]);
  const scrollToMessage = useCallback((...args: Parameters<typeof controls.scrollToMessage>) => {
    refs.programmaticScrollRef.current = true;
    return controls.scrollToMessage(...args);
  }, [controls.scrollToMessage, refs.programmaticScrollRef]);
  return { ...refs, scrollToEnd, scrollToStart, scrollToMessage };
}

function ScrollHandle({ contextRef }: { contextRef?: Ref<ConversationScrollHandle> }) {
  const { scrollRef, setSelecting, isAtBottom, scrollToEnd, scrollToStart, scrollToMessage } = useConversationScroll();
  useImperativeHandle(contextRef, () => ({ scrollToEnd, scrollToStart, scrollToMessage }), [scrollToEnd, scrollToStart, scrollToMessage]);
  const atBottomRef = useRef(isAtBottom);
  atBottomRef.current = isAtBottom;

  // Reaching the actual end also resumes native following after a manual jump
  // or scrollbar drag. A newly anchored turn already at the end keeps its mode.
  useEffect(() => {
    const viewport = scrollRef.current;
    if (isAtBottom && viewport && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2) {
      scrollToEnd({ behavior: "instant" });
    }
  }, [isAtBottom, scrollRef, scrollToEnd]);

  // Match the previous scroller: a mouse drag may select streamed text without
  // moving it underneath the pointer. Releasing the mouse resumes native following.
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    let dragging = false;
    let anchorSelectionTop: number | undefined;
    const hasSpacer = () => !!viewport.querySelector<HTMLElement>("[data-message-scroller-spacer]")?.offsetHeight;
    const onSelectionChange = () => {
      const selection = window.getSelection();
      const ancestor = selection?.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null;
      const selecting = dragging && !!ancestor && !selection?.isCollapsed &&
        (viewport.contains(ancestor) || ancestor.contains(viewport));
      if (selecting && anchorSelectionTop === undefined && atBottomRef.current && hasSpacer()) {
        anchorSelectionTop = viewport.scrollTop;
      }
      setSelecting(selecting);
    };
    const onMouseDown = (event: MouseEvent) => {
      dragging = event.button === 0;
      onSelectionChange();
    };
    const onRelease = () => {
      // The primitive normally starts following when a turn consumes its spacer.
      // If that happened while paused, finish the transition on release, unless
      // the reader moved away in the meantime.
      if (anchorSelectionTop !== undefined && Math.abs(viewport.scrollTop - anchorSelectionTop) <= 2 && !hasSpacer()) {
        scrollToEnd({ behavior: "instant" });
      }
      anchorSelectionTop = undefined;
      dragging = false;
      setSelecting(false);
    };
    viewport.addEventListener("mousedown", onMouseDown);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mouseup", onRelease);
    window.addEventListener("blur", onRelease);
    return () => {
      viewport.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mouseup", onRelease);
      window.removeEventListener("blur", onRelease);
    };
  }, [scrollRef, setSelecting, scrollToEnd]);
  return null;
}

export type ConversationProps = ComponentProps<typeof MessageScroller> & {
  contextRef?: Ref<ConversationScrollHandle>;
  /**
   * Remember the reading position under this key when the transcript unmounts
   * away from its end, and return there when it mounts again (a phone tab switch).
   */
  positionKey?: string;
};

export function Conversation({ className, children, contextRef, positionKey, ...props }: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef(false);
  const [selecting, setSelecting] = useState(false);
  const [restorePoint] = useState(() => (positionKey && savedReadingPoints.get(positionKey)) || null);
  const [isAtBottom, setIsAtBottom] = useState(!restorePoint);
  const refs = useMemo(
    () => ({ scrollRef, contentRef, selecting, setSelecting, isAtBottom, setIsAtBottom, programmaticScrollRef, positionKey, restorePoint }),
    [selecting, isAtBottom, positionKey, restorePoint],
  );

  // Include synthetic turn space when deciding whether the reader is at the end.
  // The primitive's `end` flag only measures real content, so it can report no
  // hidden content even after the reader scrolls upward within a short turn.
  // A layout effect, so a parent measuring its chrome right after mount (and
  // resizing the insets) is already seen as geometry rather than as scrolling.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const contentStyle = getComputedStyle(content);
    let geometry = scrollGeometry(viewport, contentStyle);
    const onScroll = () => {
      if (geometry !== scrollGeometry(viewport, contentStyle)) return;
      setIsAtBottom(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2);
    };
    const observer = new ResizeObserver(() => {
      geometry = scrollGeometry(viewport, contentStyle);
    });
    observer.observe(viewport);
    observer.observe(content, { box: "border-box" });
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
    };
  }, []);
  return (
    <MessageScrollerProvider autoScroll={isAtBottom && !selecting} defaultScrollPosition="end">
      <ConversationContext.Provider value={refs}>
        <MessageScroller data-testid="conversation" className={cn("flex-1", className)} {...props}>
          <ScrollHandle contextRef={contextRef} />
          {children}
        </MessageScroller>
      </ConversationContext.Provider>
    </MessageScrollerProvider>
  );
}

// Preserve the transcript's own deferred-rendering policy (including the mobile
// exceptions). Only register rows here; don't add a second content-visibility policy.
export function ConversationItem({ scrollAnchor = false, ...props }: ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  const context = useContext(ConversationContext);
  if (!context) throw new Error("ConversationItem must be used within Conversation");
  // Once the reader leaves a turn, history loading must not treat that old
  // prompt as a new jump target. Returning to the end never rearms it.
  const [canAnchor, setCanAnchor] = useState(() => context.isAtBottom);
  useEffect(() => {
    if (!context.isAtBottom) setCanAnchor(false);
  }, [context.isAtBottom]);
  return <MessageScrollerPrimitive.Item {...props} scrollAnchor={scrollAnchor && canAnchor} />;
}

export type ConversationContentProps = ComponentProps<"div"> & { scrollClassName?: string };

export function ConversationContent({ className, scrollClassName, children, ...props }: ConversationContentProps) {
  const { scrollRef, contentRef, scrollToMessage, scrollToEnd, isAtBottom, setIsAtBottom, selecting, programmaticScrollRef, positionKey, restorePoint } = useConversationScroll();
  const followingRef = useRef(isAtBottom && !selecting);
  followingRef.current = isAtBottom && !selecting;
  const atBottomRef = useRef(isAtBottom);
  atBottomRef.current = isAtBottom;

  // Return a remounted transcript to the row its reader left it at, in place of
  // the primitive's default position (a jump it is asked for first replaces that).
  // The primitive's own call, not the wrapped one: the reading anchor must take
  // its first snapshot right after, so later inset changes keep the row in place.
  const { scrollToMessage: jumpToMessage } = useMessageScroller();
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!restorePoint || !content) return;
    if (!content.querySelector(`[data-message-id="${CSS.escape(restorePoint.messageId)}"]`)) {
      // The row is gone (reloaded or trimmed): stay at the end the primitive chose.
      setIsAtBottom(true);
      return;
    }
    // `start` alignment measures from the content's top padding.
    const scrollMargin = restorePoint.offset - Number.parseFloat(getComputedStyle(content).paddingTop);
    jumpToMessage(restorePoint.messageId, { align: "start", behavior: "instant", scrollMargin });
  }, [contentRef, restorePoint, setIsAtBottom, jumpToMessage]);

  // Unmount still has the DOM laid out: the layout cleanup runs before it is removed.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!positionKey || !viewport || !content) return;
    return () => {
      if (atBottomRef.current) {
        savedReadingPoints.delete(positionKey);
        return;
      }
      const bounds = viewport.getBoundingClientRect();
      for (const element of content.children) {
        if (!(element instanceof HTMLElement) || !element.dataset.messageId) continue;
        const rect = element.getBoundingClientRect();
        if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
          savedReadingPoints.set(positionKey, { messageId: element.dataset.messageId, offset: rect.top - bounds.top });
          return;
        }
      }
    };
  }, [scrollRef, contentRef, positionKey]);

  useReadingScrollAnchor(scrollRef, contentRef, followingRef, programmaticScrollRef);

  // The primitive schedules resize handling in rAF, and never sees the content's
  // padding change. Pin a following viewport before paint on both, so neither a
  // keyboard/side-panel resize nor a late-measured header or composer inset
  // exposes a gap. Reading-position compensation runs separately while browsing.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const contentStyle = getComputedStyle(content);
    let geometry = scrollGeometry(viewport, contentStyle);
    const observer = new ResizeObserver(() => {
      const next = scrollGeometry(viewport, contentStyle);
      if (next === geometry) return;
      geometry = next;
      // A short new turn has synthetic space below it. It reports no unread
      // content too, but must keep its turn anchor rather than jump to the end.
      const spacer = viewport.querySelector<HTMLElement>("[data-message-scroller-spacer]");
      if (followingRef.current && !spacer?.offsetHeight) scrollToEnd({ behavior: "instant" });
    });
    observer.observe(viewport);
    observer.observe(content, { box: "border-box" });
    return () => observer.disconnect();
  }, [scrollRef, contentRef, scrollToEnd]);

  // A disclosure is deliberate reading, not streamed output. Leave following
  // mode before it grows, without moving the viewport from its current bottom.
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[aria-expanded]")) return;
      if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 2) return;
      const rows = contentRef.current?.querySelectorAll<HTMLElement>("[data-message-id]");
      const lastId = rows?.[rows.length - 1]?.dataset.messageId;
      if (!lastId) return;
      setIsAtBottom(false);
      scrollToMessage(lastId, { align: "end", behavior: "instant" });
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2) {
          setIsAtBottom(true);
          scrollToEnd({ behavior: "instant" });
        }
      }, 400);
    };
    viewport.addEventListener("click", onClick, true);
    return () => {
      viewport.removeEventListener("click", onClick, true);
      clearTimeout(restoreTimer);
    };
  }, [scrollRef, contentRef, scrollToMessage, scrollToEnd, setIsAtBottom]);

  return (
    <MessageScrollerViewport
      ref={scrollRef}
      data-conversation-scroller
      // The reading anchor owns compensation, including deferred row resizes.
      preserveScrollOnPrepend={false}
      className={cn("[overflow-anchor:none]", scrollClassName)}
    >
      <MessageScrollerContent
        ref={contentRef}
        data-testid="message-list"
        className={cn("gap-8 p-4", className)}
        {...props}
      >
        {children}
      </MessageScrollerContent>
    </MessageScrollerViewport>
  );
}

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button> & { glass?: boolean };

export function ConversationScrollButton({ className, glass, variant: _variant, size: _size, asChild: _asChild, onClick, ...props }: ConversationScrollButtonProps) {
  const { isAtBottom, setIsAtBottom, scrollRef, scrollToEnd } = useConversationScroll();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const native = useNativeScrollButton(buttonRef, !isAtBottom);
  return (
    <Button
      {...props}
      ref={buttonRef}
      style={{ ...props.style, ...(native ? { visibility: 'hidden', transition: 'none', translate: '-50% 0', scale: '1' } : {}) }}
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Scroll to bottom"
      inert={isAtBottom}
      data-slot="message-scroller-button"
      data-direction="end"
      data-active={!isAtBottom}
      tabIndex={isAtBottom ? -1 : props.tabIndex}
      className={cn(
        messageScrollerButtonClassName,
        glass && "liquid-glass size-9 border-none text-foreground/80", className,
      )}
      onClick={(event) => {
        if (isAtBottom) return;
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.currentTarget.blur();
        const viewport = scrollRef.current;
        if (viewport && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2) setIsAtBottom(true);
        scrollToEnd({ behavior: "smooth" });
      }}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}
