import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { lazy, Suspense } from "react";
import { InlineFileCode } from "@/components/editor/FileCitationChip";
import { useMarkdownLinkHandler } from "@/lib/markdown-links";
import { remarkFileCitations } from "@/lib/remark-file-citations";
import type { RichMarkdownProps } from "./rich-markdown";
import { UiBlock } from "./ui-block";

const MermaidBlock = lazy(() => import("./mermaid-block"));

export default function PortableMarkdown({
  children, className, uiBlocks, citations, headingIds, breaks, codeControls = true,
}: RichMarkdownProps) {
  const onClick = useMarkdownLinkHandler();
  const components: Components = {
    a: ({ node: _node, ...props }) => <a data-markdown="a" {...props} />,
    table: ({ node: _node, ...props }) => (
      <div className="markdown-table-scroll">
        <table {...props} />
      </div>
    ),
    pre: ({ node, children, ...props }) => {
      const code = node?.children.find((element) => element.type === "element" && element.tagName === "code");
      const names = code?.type === "element" && code.properties.className;
      const text = code?.type === "element"
        ? code.children.map((element) => element.type === "text" ? element.value : "").join("")
        : "";
      if (Array.isArray(names) && names.includes("language-mermaid")) {
        return <Suspense><MermaidBlock source={text} incomplete={false} controls={codeControls} /></Suspense>;
      }
      if (uiBlocks && Array.isArray(names) && names.includes("language-ui")) return <UiBlock code={text} />;
      return <pre {...props}>{children}</pre>;
    },
    ...(citations ? { code: ({ node: _node, ...props }) => <InlineFileCode {...props} /> } : {}),
  };

  return (
    <div className={className} onClick={onClick}>
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm, ...(citations ? [remarkFileCitations] : []), ...(breaks ? [remarkBreaks] : [])]}
        rehypePlugins={[rehypeRaw, rehypeSanitize, ...(headingIds ? [rehypeSlug] : [])]}
        urlTransform={defaultUrlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
