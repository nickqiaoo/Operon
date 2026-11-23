import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { InlineFileCode } from "@/components/editor/FileCitationChip";
import { remarkFileCitations } from "@/lib/remark-file-citations";

const components: Components = {
  code: ({ node: _node, ...props }) => <InlineFileCode {...props} />,
};

const comments = /<!--[\s\S]*?(?:-->|$)/g;
const tags = /<[^>]*>/g;
const visibleMedia = /<(?:img|video|audio|svg|picture|iframe|hr|input)\b/i;

/**
 * A block of nothing but tags — an agent quoting a README's first line,
 * `<p align="center">` — renders as an empty element, and the message would
 * look blank. Text (even inside a stripped `<script>`) or media means the block
 * is meant to render; comments are meant to be hidden.
 */
function onlyTags(html: string): boolean {
  const source = html.replace(comments, "");
  if (source.trim() === "") return false;
  return source.replace(tags, "").trim() === "" && !visibleMedia.test(source);
}

/**
 * A raw HTML block (`<details>`, `<table>`…) that `prepareMarkdownHtml` lifted
 * out of a Words reply. Words doesn't sanitize HTML, so these go through
 * rehype-raw + rehype-sanitize; markdown written inside the block still renders.
 * HTML that would render to nothing is shown as the text it is.
 */
export default function MarkdownHtmlBlock({ children }: { children: string }) {
  if (onlyTags(children)) return <p>{children.trim()}</p>;
  return (
    <ReactMarkdown
      components={components}
      remarkPlugins={[remarkGfm, remarkFileCitations]}
      rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeSlug]}
      urlTransform={defaultUrlTransform}
    >
      {children}
    </ReactMarkdown>
  );
}
