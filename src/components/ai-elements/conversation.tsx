"use client";

import { MessageScroller as MessageScrollerPrimitive } from "@/lib/shadcn-react/message-scroller";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  messageScrollerButtonClassName,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@/components/ui/message-scroller";
import { cn } from "@/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import { useScrollFade } from "./use-scroll-fade";
import { useNativeScrollButton } from "@/hooks/useNativeScrollButton";
import {
  createContext, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type ComponentProps, type Ref, type RefObject,
} from "react";

export type ConversationScrollHandle = Pick<ReturnType<typeof useMessageScroller>, "scrollToEnd" | "scrollToStart" | "scrollToMessage">;

/** A row and its distance from the viewport's top edge. */
type ReadingPoint = { messageId: string; offset: number };
/** Where readers left transcripts that unmounted mid-history, by `positionKey`. */
const savedReadingPoints = new Map<string, ReadingPoint>();

/** Distance from the viewport's bottom edge to the end, synthetic turn space included. */
function distanceToEnd(viewport: HTMLElement) {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
}

/**
 * Height of the synthetic space below a short new turn, which keeps its prompt
 * at the top. While it shows, the turn is anchored: `scrollToEnd` and
 * `scrollToMessage` both drop it and drag the turn down to the end.
 */
function spacerHeight(viewport: HTMLElement) {
  return viewport.querySelector<HTMLElement>("[data-message-scroller-spacer]")?.offsetHeight ?? 0;
}

/*
 * Following the live end, releasing it, re-arming it and the scroll button all
 * belong to the scroller (the fork in src/lib/shadcn-react, see its UPSTREAM.md).
 * This file only pauses it for the reader's own actions (selecting text, opening
 * a disclosure) through its `autoScroll` switch and public commands. Keep it that
 * way: a second "is the reader at the end" kept here, in React state, lags the
 * scroller by a render, and every bug the transcript had came from the two
 * disagreeing for a frame.
 */

type ConversationRefs = {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  /** Pause following while the reader drags a text selection. */
  setSelecting: (selecting: boolean) => void;
  /** Pause following while a disclosure the reader opened settles. */
  setHolding: (holding: boolean) => void;
  /**
   * A remount is returning to a saved reading point and the scroller has not
   * published where it landed yet. Its first snapshot says "at the end", which
   * would tell the transcript (e.g. the assistant's render window) the reader
   * is at the newest message and trim the row being returned to.
   */
  restoring: boolean;
  setRestoring: (restoring: boolean) => void;
  positionKey?: string;
  restorePoint: ReadingPoint | null;
};
const ConversationContext = createContext<ConversationRefs | null>(null);

export function useConversationScroll() {
  const refs = useContext(ConversationContext);
  if (!refs) throw new Error("useConversationScroll must be used within Conversation");
  const controls = useMessageScroller();
  const end = useMessageScrollerScrollable("end");
  const isAtBottom = !refs.restoring && !end;
  return { ...refs, ...controls, isAtBottom };
}

function ScrollHandle({ contextRef }: { contextRef?: Ref<ConversationScrollHandle> }) {
  const { scrollRef, setSelecting, scrollToEnd, scrollToStart, scrollToMessage } = useConversationScroll();
  useImperativeHandle(contextRef, () => ({ scrollToEnd, scrollToStart, scrollToMessage }), [scrollToEnd, scrollToStart, scrollToMessage]);

  // Match the previous scroller: a mouse drag may select streamed text without
  // moving it underneath the pointer. Releasing the mouse resumes following.
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    let dragging = false;
    let anchorSelectionTop: number | undefined;
    const hasSpacer = () => spacerHeight(viewport) > 0;
    const onSelectionChange = () => {
      const selection = window.getSelection();
      const ancestor = selection?.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null;
      const selecting = dragging && !!ancestor && !selection?.isCollapsed &&
        (viewport.contains(ancestor) || ancestor.contains(viewport));
      if (selecting && anchorSelectionTop === undefined && distanceToEnd(viewport) <= 2 && hasSpacer()) {
        anchorSelectionTop = viewport.scrollTop;
      }
      setSelecting(selecting);
    };
    const onMouseDown = (event: MouseEvent) => {
      dragging = event.button === 0;
      onSelectionChange();
    };
    const onRelease = () => {
      // An anchored turn hands off to following when its reply consumes the
      // spacer, but only while following is allowed. If that happened during the
      // drag, finish the hand-off on release, unless the reader moved away.
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
  turnActive?: boolean;
  /**
   * Remember the reading position under this key when the transcript unmounts
   * away from its end, and return there when it mounts again (a phone tab switch).
   */
  positionKey?: string;
};

export function Conversation({ className, children, contextRef, positionKey, turnActive, ...props }: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [holding, setHolding] = useState(false);
  const [restorePoint] = useState(() => (positionKey && savedReadingPoints.get(positionKey)) || null);
  const [restoring, setRestoring] = useState(() => restorePoint !== null);
  const refs = useMemo(
    () => ({ scrollRef, contentRef, setSelecting, setHolding, restoring, setRestoring, positionKey, restorePoint }),
    [restoring, positionKey, restorePoint],
  );
  return (
    <MessageScrollerProvider autoScroll={!selecting && !holding && !restoring} defaultScrollPosition="end" turnActive={turnActive}>
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
  const { isAtBottom } = useConversationScroll();
  // A prompt sent while the reader is up in the history keeps them there. Once
  // the reader leaves a turn, history loading must not treat that old prompt as
  // a new jump target either; returning to the end never rearms it.
  const [canAnchor, setCanAnchor] = useState(() => isAtBottom);
  useEffect(() => {
    if (!isAtBottom) setCanAnchor(false);
  }, [isAtBottom]);
  return <MessageScrollerPrimitive.Item {...props} scrollAnchor={scrollAnchor && canAnchor} />;
}

export type ConversationContentProps = ComponentProps<"div"> & {
  scrollClassName?: string;
  /**
   * Fade the edges that have content beyond them (`scroll-fade-y`), with sizes
   * measured after layout: don't put the class in `scrollClassName`, whose
   * scroll-linked sizes lag a frame and flicker while content shrinks.
   */
  fadeEdges?: boolean;
};

export function ConversationContent({ className, scrollClassName, fadeEdges = false, children, ...props }: ConversationContentProps) {
  const { scrollRef, contentRef, scrollToEnd, scrollToMessage, stopFollowing, setHolding, setRestoring, positionKey, restorePoint } = useConversationScroll();

  // Return a remounted transcript to the row its reader left it at, in place of
  // the primitive's default position (a jump it is asked for first replaces that).
  // The jump holds the row where it lands until the reader scrolls, so insets
  // measured after mount do not move it.
  // When the row is gone (reloaded or trimmed), stay at the end the primitive chose.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!restorePoint || !content) return;
    if (content.querySelector(`[data-message-id="${CSS.escape(restorePoint.messageId)}"]`)) {
      // `start` alignment measures from the content's top padding.
      const scrollMargin = restorePoint.offset - Number.parseFloat(getComputedStyle(content).paddingTop);
      scrollToMessage(restorePoint.messageId, { align: "start", behavior: "instant", scrollMargin });
    }
    // The scroller publishes its state on the next frame; this frame callback is
    // queued after its own, so the snapshot is current when the hold lifts.
    const frame = requestAnimationFrame(() => setRestoring(false));
    return () => cancelAnimationFrame(frame);
  }, [contentRef, restorePoint, scrollToMessage, setRestoring]);

  // Unmount still has the DOM laid out: the layout cleanup runs before it is removed.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!positionKey || !viewport || !content) return;
    return () => {
      if (distanceToEnd(viewport) <= 2) {
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

  useScrollFade(scrollRef, contentRef, fadeEdges);

  // A disclosure is deliberate reading, not streamed output: opening one at the
  // end must not drag the reader down to its last line.
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[aria-expanded]")) return;
      if (distanceToEnd(viewport) > 2) return;
      clearTimeout(restoreTimer);
      // A short new turn sits at the top of its spacer and stays there as the
      // disclosure resizes (the scroller re-anchors it). Only hold off the
      // hand-off to following, which would drag the turn down once the spacer
      // runs out.
      if (spacerHeight(viewport) > 0) {
        setHolding(true);
        restoreTimer = setTimeout(() => setHolding(false), 400);
        return;
      }
      // Otherwise leave following before the content grows. If the disclosure
      // fit without pushing anything below the fold, resume once it settles.
      stopFollowing();
      restoreTimer = setTimeout(() => {
        if (distanceToEnd(viewport) <= 2) scrollToEnd({ behavior: "instant" });
      }, 400);
    };
    viewport.addEventListener("click", onClick, true);
    return () => {
      viewport.removeEventListener("click", onClick, true);
      clearTimeout(restoreTimer);
    };
  }, [scrollRef, stopFollowing, scrollToEnd, setHolding]);

  return (
    <MessageScrollerViewport
      ref={scrollRef}
      data-conversation-scroller
      className={cn(fadeEdges && "scroll-fade-y", scrollClassName)}
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
  const { scrollToEnd } = useMessageScroller();
  const hasContentBelow = useMessageScrollerScrollable("hasContentBelow");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const native = useNativeScrollButton(buttonRef, hasContentBelow);
  return (
    <Button
      {...props}
      ref={buttonRef}
      style={{ ...props.style, ...(native ? { visibility: 'hidden', transition: 'none', translate: '-50% 0', scale: '1' } : {}) }}
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Scroll to bottom"
      inert={!hasContentBelow}
      data-slot="message-scroller-button"
      data-direction="end"
      data-active={hasContentBelow}
      tabIndex={hasContentBelow ? props.tabIndex : -1}
      className={cn(
        messageScrollerButtonClassName,
        glass && "liquid-glass size-9 border-none text-foreground/80", className,
      )}
      onClick={(event) => {
        if (!hasContentBelow) return;
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.currentTarget.blur();
        scrollToEnd({ behavior: "smooth" });
      }}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}
