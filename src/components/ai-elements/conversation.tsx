"use client";

import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
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
};
const ConversationContext = createContext<ConversationRefs | null>(null);

export function useConversationScroll() {
  const refs = useContext(ConversationContext);
  if (!refs) throw new Error("useConversationScroll must be used within Conversation");
  const controls = useMessageScroller();
  const { end } = useMessageScrollerScrollable();
  return { ...refs, ...controls, isAtBottom: !end };
}

function ScrollHandle({ contextRef }: { contextRef?: Ref<ConversationScrollHandle> }) {
  const { scrollRef, setSelecting, isAtBottom, scrollToEnd, scrollToStart, scrollToMessage } = useConversationScroll();
  useImperativeHandle(contextRef, () => ({ scrollToEnd, scrollToStart, scrollToMessage }), [scrollToEnd, scrollToStart, scrollToMessage]);
  const atBottomRef = useRef(isAtBottom);
  atBottomRef.current = isAtBottom;

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
  const refs = useMemo(() => ({ scrollRef, contentRef, selecting, setSelecting }), [selecting]);
  return (
    <MessageScrollerProvider autoScroll={!selecting} defaultScrollPosition="end">
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
export const ConversationItem = MessageScrollerPrimitive.Item;

export type ConversationContentProps = ComponentProps<"div"> & { scrollClassName?: string };

export function ConversationContent({ className, scrollClassName, children, ...props }: ConversationContentProps) {
  const { scrollRef, contentRef, scrollToMessage, scrollToEnd, isAtBottom, selecting } = useConversationScroll();
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
      scrollToMessage(lastId, { align: "end", behavior: "instant" });
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2) {
          scrollToEnd({ behavior: "instant" });
        }
      }, 400);
    };
    viewport.addEventListener("click", onClick, true);
    return () => {
      viewport.removeEventListener("click", onClick, true);
      clearTimeout(restoreTimer);
    };
  }, [scrollRef, contentRef, scrollToMessage, scrollToEnd]);

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

export function ConversationScrollButton({ className, glass, variant: _variant, size: _size, asChild: _asChild, ...props }: ConversationScrollButtonProps) {
  return (
    <MessageScrollerButton
      aria-label="Scroll to bottom"
      className={cn(glass && "liquid-glass size-9 border-none text-foreground/80", className)}
      render={<Button type="button" variant="ghost" size="icon-sm" />}
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </MessageScrollerButton>
  );
}
