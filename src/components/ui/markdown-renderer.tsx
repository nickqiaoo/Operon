import { memo } from "react";
import { RichMarkdown } from "@/components/ai-elements/rich-markdown";
import { cn } from "@/lib/utils";
import type { MarkdownMention } from "@/lib/markdown-mentions";

export interface MarkdownRendererProps {
  content: string;
  className?: string;
  /** Render single newlines as hard breaks in surfaces such as the README preview. */
  breaks?: boolean;
  /** Bare GitHub PR / issue URLs render as chips; pair with `GithubLinkProvider` for state. */
  githubLinks?: boolean;
  /** `@name` for these names renders highlighted (channel members). */
  mentions?: readonly MarkdownMention[];
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, className, breaks, githubLinks, mentions }: MarkdownRendererProps) {
  return (
    <RichMarkdown
      mode="static"
      citations
      headingIds
      breaks={breaks}
      githubLinks={githubLinks}
      mentions={mentions}
      className={cn(
        "prose max-w-none w-full",
        "prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0",
        "prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-1.5 prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-h4:text-sm phone:prose-h1:text-xl phone:prose-h2:text-lg phone:prose-h3:text-base phone:prose-h4:text-base",
        "prose-p:leading-[1.4] prose-li:leading-[1.35] prose-p:my-0.5 prose-li:my-0",
        "break-words",
        className
      )}
    >
      {content}
    </RichMarkdown>
  );
});
