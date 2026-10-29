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
import {
  createContext, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type ComponentProps, type Ref, type RefObject,
} from "react";

export type ConversationScrollHandle = ReturnType<typeof useMessageScroller>;

type ConversationRefs = {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  selecting: boolean;
  setSelecting: (selecting: boolean) => void;
  isAtBottom: boolean;
  setIsAtBottom: (atBottom: boolean) => void;
};
const ConversationContext = createContext<ConversationRefs | null>(null);

export function useConversationScroll() {
  const refs = useContext(ConversationContext);
  if (!refs) throw new Error("useConversationScroll must be used within Conversation");
  const controls = useMessageScroller();
  return { ...refs, ...controls };
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
};

export function Conversation({ className, children, contextRef, ...props }: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const refs = useMemo(() => ({ scrollRef, contentRef, selecting, setSelecting, isAtBottom, setIsAtBottom }), [selecting, isAtBottom]);

  // Include synthetic turn space when deciding whether the reader is at the end.
  // The primitive's `end` flag only measures real content, so it can report no
  // hidden content even after the reader scrolls upward within a short turn.
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    let width = viewport.clientWidth;
    let height = viewport.clientHeight;
    const onScroll = () => {
      if (width !== viewport.clientWidth || height !== viewport.clientHeight) return;
      setIsAtBottom(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2);
    };
    const observer = new ResizeObserver(() => {
      width = viewport.clientWidth;
      height = viewport.clientHeight;
    });
    observer.observe(viewport);
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
  // Decide once when this row arrives. Returning to the end must not turn an
  // already received prompt into a fresh automatic jump.
  const [canAnchor] = useState(() => context.isAtBottom);
  return <MessageScrollerPrimitive.Item {...props} scrollAnchor={scrollAnchor && canAnchor} />;
}

export type ConversationContentProps = ComponentProps<"div"> & { scrollClassName?: string };

export function ConversationContent({ className, scrollClassName, children, ...props }: ConversationContentProps) {
  const { scrollRef, contentRef, scrollToMessage, scrollToEnd, isAtBottom, setIsAtBottom, selecting } = useConversationScroll();
  const followingRef = useRef(isAtBottom && !selecting);
  followingRef.current = isAtBottom && !selecting;

  // The primitive schedules resize handling in rAF. Pin a following viewport
  // before paint as well, so a keyboard/side-panel resize never exposes a gap
  // for a frame. Content growth and reading-position preservation stay native.
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    let width = viewport.clientWidth;
    let height = viewport.clientHeight;
    const observer = new ResizeObserver(() => {
      if (width === viewport.clientWidth && height === viewport.clientHeight) return;
      width = viewport.clientWidth;
      height = viewport.clientHeight;
      // A short new turn has synthetic space below it. It reports no unread
      // content too, but must keep its turn anchor rather than jump to the end.
      const spacer = viewport.querySelector<HTMLElement>("[data-message-scroller-spacer]");
      if (followingRef.current && !spacer?.offsetHeight) scrollToEnd({ behavior: "instant" });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [scrollRef, scrollToEnd]);

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
    <MessageScrollerViewport ref={scrollRef} data-conversation-scroller className={scrollClassName}>
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
  return (
    <Button
      {...props}
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
