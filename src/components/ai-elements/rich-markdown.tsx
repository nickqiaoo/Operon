import { lazy, memo, Suspense } from "react";
import type { MarkdownMention } from "@/lib/markdown-mentions";

export interface RichMarkdownProps {
  children: string;
  className?: string;
  mode?: "static" | "streaming";
  isAnimating?: boolean;
  parseIncompleteMarkdown?: boolean;
  uiBlocks?: boolean;
  citations?: boolean;
  headingIds?: boolean;
  breaks?: boolean;
  codeControls?: boolean;
  /** Bare GitHub PR / issue URLs render as chips (see `GithubLinkChip`). */
  githubLinks?: boolean;
  /** `@name` for these names renders highlighted (channel members). */
  mentions?: readonly MarkdownMention[];
}

// Words (WASM) is the only renderer; every supported runtime can load WASM.
const WordsMarkdown = lazy(() => import("./words-message-markdown"));

export const RichMarkdown = memo(function RichMarkdown(props: RichMarkdownProps) {
  return (
    <Suspense>
      <WordsMarkdown {...props} />
    </Suspense>
  );
});
