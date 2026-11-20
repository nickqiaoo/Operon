import { canUseWASM } from "@pierre/diffs";
import { lazy, memo, Suspense } from "react";

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
}

const PortableMarkdown = lazy(() => import("./portable-markdown"));
const WordsMarkdown = lazy(() =>
  import("./words-message-markdown").catch(() => import("./portable-markdown"))
);

export const RichMarkdown = memo(function RichMarkdown(props: RichMarkdownProps) {
  const Renderer = canUseWASM() ? WordsMarkdown : PortableMarkdown;
  return (
    <Suspense>
      <Renderer {...props} />
    </Suspense>
  );
});
