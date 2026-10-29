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
import { safeCode } from "@/lib/streamdown-code";
import { cn } from "@/lib/utils";
import { openExternalUrl } from "@/lib/open-external";
import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { UIMessage } from "ai";
import { useFileOpenHandler } from "@/lib/file-open-context";
import type { AnchorHTMLAttributes, ComponentProps } from "react";
import { createContext, memo, useCallback, useContext } from "react";
import { Streamdown, defaultUrlTransform } from "streamdown";
import remarkGfm from "remark-gfm";
import { remarkFileCitations } from "@/lib/remark-file-citations";
import { InlineFileCode } from "@/components/editor/FileCitationChip";
import type { PluggableList } from "unified";

/** Allow absolute file paths through URL sanitization */
const messageUrlTransform: typeof defaultUrlTransform = (url, key, node) => {
  if (url.startsWith("/")) return url;
  return defaultUrlTransform(url, key, node) ?? url;
};

function MessageLink({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const openFile = useFileOpenHandler();
  const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    e.preventDefault();
    if (href.startsWith("#")) {
      const id = href.slice(1);
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (href.startsWith("http://") || href.startsWith("https://")) {
      openExternalUrl(href);
      return;
    }
    // Local file path
    if (href.startsWith("/")) {
      const hash = href.match(/#L(\d+)/);
      openFile(
        href.split("#")[0],
        hash ? { line: Number.parseInt(hash[1], 10) } : undefined
      );
    }
  }, [href, openFile]);

  return (
    <a href={href} onClick={handleClick} {...props}>
      {children}
    </a>
  );
}

const messageComponents = { a: MessageLink, inlineCode: InlineFileCode };
// File citations (【F:path†L…】) → clickable inline-code chips.
// remarkGfm is required for tables/strikethrough/task-lists: passing a custom
// remarkPlugins array replaces Streamdown's default set (which bundles gfm), so
// we must re-add it here or GFM tables silently degrade to plain paragraphs.
const messageRemarkPlugins: PluggableList = [remarkGfm, remarkFileCitations];

const code = safeCode;

const fencePattern = /^(\s*)(`{3,}|~{3,})([^\n]*)$/;
function closeUnterminatedCodeFence(content: string): string {
  let openFence: string | null = null;

  for (const line of content.split("\n")) {
    const match = line.match(fencePattern);
    if (!match) continue;

    const marker = match[2];
    if (!openFence) {
      openFence = marker;
      continue;
    }

    if (openFence[0] === marker[0] && marker.length >= openFence.length) {
      openFence = null;
    }
  }

  if (!openFence) return content;
  if (!content.trimEnd()) return content;

  const suffix = content.endsWith("\n") ? "" : "\n";
  return `${content}${suffix}${openFence}`;
}

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

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const MessageResponseInner = ({ className, children, ...props }: MessageResponseProps) => {

  return (
    <div>
      <Streamdown
        className={cn(
          // Heading sizes are relative to the body so callers that change the body size
          // (the assistant's 17px compact mode) keep the same one-step-up scale.
          "prose size-full text-[0.9rem] leading-tight prose-headings:mt-3 prose-headings:mb-1 prose-h1:text-[1.25em] prose-h2:text-[1.125em] prose-h3:text-[1em] prose-h4:text-[1em] prose-p:my-0 prose-p:[&:not(:last-child)]:mb-1 space-y-2! [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className
        )}
        plugins={{ code, mermaid, math, cjk }}
        controls={{ table: false, code: { copy: true, download: false } }}
        remarkPlugins={messageRemarkPlugins}
        urlTransform={messageUrlTransform}
        components={messageComponents}
        children={typeof children === "string" ? closeUnterminatedCodeFence(children) : children}
        {...props}
      />
    </div>
  );
};

export const MessageResponse = memo(MessageResponseInner);

MessageResponse.displayName = "MessageResponse";
