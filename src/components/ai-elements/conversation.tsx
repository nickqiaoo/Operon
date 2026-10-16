"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    data-testid="conversation"
    className={cn(
      "relative flex-1 min-h-0 overflow-y-hidden",
      className
    )}
    initial={false}
    role="log"
    {...props}
  />
);

export type ConversationContentProps = Omit<ComponentProps<"div">, "children"> & {
  /** Classes for the scrolling element (the outer div), e.g. `scroll-fade-y`. */
  scrollClassName?: string;
  children?:
  | ReactNode
  | ((context: ReturnType<typeof useStickToBottomContext>) => ReactNode);
};

export const ConversationContent = ({
  className,
  scrollClassName,
  children,
  ...props
}: ConversationContentProps) => {
  const context = useStickToBottomContext();
  const { scrollRef, contentRef, state, scrollToBottom } = context;
  const content = typeof children === "function" ? children(context) : children;

  // When the scroller itself changes size the library doesn't follow at all
  // (it only watches the content): narrowing (a side panel animating open)
  // reflows the content taller, and getting shorter (a phone keyboard or a
  // composer growing from below) leaves the newest message under the fold.
  // Pin the bottom inside the ResizeObserver callback: it runs after layout
  // but before paint, so the frame is already painted bottom-anchored.
  //
  // Don't trust `state.isAtBottom` alone for this: when the scroller widens or
  // gets taller the browser clamps scrollTop downward, and the library
  // sometimes (timing race in its resize-vs-scroll bookkeeping) reads that as
  // the user scrolling up and drops the lock. So track "at bottom" from
  // geometry at scroll time, and once the size settles, hand the lock back to
  // the library if it lost it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = () => el.scrollHeight - el.clientHeight - el.scrollTop;
    let pinned = state.isAtBottom || gap() <= 2;
    let lastWidth = el.clientWidth;
    let lastHeight = el.clientHeight;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const onScroll = () => {
      pinned = state.isAtBottom || gap() <= 2;
    };
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      if (!pinned) return;
      el.scrollTop = el.scrollHeight - el.clientHeight;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (!state.isAtBottom && gap() <= 2) {
          state.escapedFromLock = false;
          void scrollToBottom({ animation: "instant" });
        }
      }, 100);
    });

    el.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      clearTimeout(settleTimer);
    };
  }, [scrollRef, state, scrollToBottom]);

  // The library follows the bottom only when the content grows. A thread that renders a
  // sliding window (the assistant's newest 40) drops its oldest message as a new one lands:
  // if the one leaving is taller, the content shrinks, scroll anchoring pulls scrollTop back
  // by what left above, and the new message sits below the fold with nothing moving to it.
  // While still locked to the bottom, follow it down for a shrink too.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    let previousHeight = content.offsetHeight;
    const observer = new ResizeObserver(() => {
      const height = content.offsetHeight;
      const shrank = height < previousHeight;
      previousHeight = height;
      if (!shrank || !state.isAtBottom || state.escapedFromLock) return;
      if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2) return;
      void scrollToBottom({ preserveScrollPosition: true, wait: true });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollRef, contentRef, state, scrollToBottom]);

  return (
    <div ref={scrollRef} data-conversation-scroller className={cn("h-full w-full overflow-y-auto code-scrollbar", scrollClassName)}>
      <div
        ref={contentRef}
        data-testid="message-list"
        className={cn("flex flex-col gap-8 p-4", className)}
        {...props}
      >
        {content}
      </div>
    </div>
  );
};

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

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full shadow-card",
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="secondary"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};
