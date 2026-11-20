"use client";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Message as MessageRoot,
  MessageContent as MessageBody,
  MessageFooter,
} from "@/components/ui/message";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RichMarkdown, type RichMarkdownProps } from "@/components/ai-elements/rich-markdown";
import { cn } from "@/lib/utils";
import { linkLocalMarkdownImages } from "@/lib/reply-images";
import type { UIMessage } from "ai";
import type { ComponentProps } from "react";
import { createContext, memo, useContext } from "react";

/**
 * Message, rebuilt on shadcn/ui Message + Bubble (https://ui.shadcn.com/docs/ai-elements/radix/message):
 * the person's turn is a bubble on the right, the agent's reply runs full width
 * with no bubble. Its parts stack (content, then the action footer) rather than
 * sitting beside an avatar, so the row is a column here.
 */

type MessageFrom = UIMessage["role"];

const MessageFromContext = createContext<MessageFrom>("assistant");

export type MessageProps = ComponentProps<typeof MessageRoot> & {
  from: MessageFrom;
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <MessageFromContext.Provider value={from}>
    <MessageRoot
      data-testid={`message-${from}`}
      align={from === "user" ? "end" : "start"}
      className={cn(
        "flex-col data-[align=end]:flex-col",
        // Only the user bubble is capped short of the column. An assistant reply
        // runs the full width so its right edge lines up with the turn's diff
        // card and the composer, which sit outside <Message>.
        from === "user" ? "ml-auto max-w-[95%] items-end" : "max-w-full",
        className
      )}
      {...props}
    />
  </MessageFromContext.Provider>
);

type BubbleVariant = NonNullable<ComponentProps<typeof Bubble>["variant"]>;

export type MessageContentProps = ComponentProps<typeof MessageBody> & {
  /**
   * The bubble around the content: `secondary` for the person's turn by
   * default, none for the agent's. `none` drops the bubble.
   */
  variant?: BubbleVariant | "none";
};

export const MessageContent = ({
  children,
  className,
  variant,
  ...props
}: MessageContentProps) => {
  const from = useContext(MessageFromContext);
  const bubble = variant ?? (from === "user" ? "secondary" : "none");

  if (bubble === "none") {
    return (
      <MessageBody className={cn("w-full gap-1 text-foreground", className)} {...props}>
        {children}
      </MessageBody>
    );
  }

  return (
    <MessageBody className="w-fit max-w-full gap-1" {...props}>
      <Bubble
        align={from === "user" ? "end" : "start"}
        variant={bubble}
        className="max-w-full"
      >
        <BubbleContent className={cn("flex flex-col gap-1", className)}>{children}</BubbleContent>
      </Bubble>
    </MessageBody>
  );
};

export type MessageActionsProps = ComponentProps<typeof MessageFooter>;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <MessageFooter className={cn("gap-1 px-0", className)} {...props}>
    {children}
  </MessageFooter>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button aria-label={label || tooltip} size={size} type="button" variant={variant} {...props}>
      {children}
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

type MessageResponseProps = Pick<
  RichMarkdownProps, "children" | "className" | "mode" | "isAnimating" | "parseIncompleteMarkdown"
>;

/** Phone reading size for chat replies: 17px at 1.4, the iOS body size — the desktop's
 *  0.9rem at tight leading reads small at arm's length. Prose sets its own p/li leading,
 *  so those are overridden too, and blocks get 12px apart (the desktop's 8px runs
 *  paragraphs together at this size). */
export const PHONE_REPLY_TEXT = "text-[17px] leading-[1.4] [&_li]:leading-[1.4] [&_p]:leading-[1.4] space-y-3!";
export const PHONE_REPLY_TEXT_MD = "phone:text-[17px] phone:leading-[1.4] phone:[&_li]:leading-[1.4] phone:[&_p]:leading-[1.4] phone:space-y-3!";

export const MessageResponse = memo(function MessageResponse({ className, children, ...props }: MessageResponseProps) {
  return (
    <RichMarkdown
      {...props}
      className={cn(
        "prose size-full text-[0.9rem] leading-tight prose-headings:mt-3 prose-headings:mb-1 prose-h1:text-[1.25em] prose-h2:text-[1.125em] prose-h3:text-[1em] prose-h4:text-[1em] prose-p:my-0 prose-p:[&:not(:last-child)]:mb-1 space-y-2! [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
      citations
      uiBlocks
    >
      {linkLocalMarkdownImages(children)}
    </RichMarkdown>
  );
});
