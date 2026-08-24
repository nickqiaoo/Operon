"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useCallback } from "react";
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
  children?:
  | ReactNode
  | ((context: ReturnType<typeof useStickToBottomContext>) => ReactNode);
};

export const ConversationContent = ({
  className,
  children,
  ...props
}: ConversationContentProps) => {
  const context = useStickToBottomContext();
  const { scrollRef, contentRef } = context;
  const content = typeof children === "function" ? children(context) : children;

  return (
    <div ref={scrollRef} className="h-full w-full overflow-y-auto scrollbar-none">
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
