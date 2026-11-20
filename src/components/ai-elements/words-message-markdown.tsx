import { createHighlightsPlugin } from "@pierre/words/highlights";
import { escapeHtml } from "@pierre/words/html";
import { Markdown, type Components, type PluginConfig } from "@pierre/words/react";
import { PIERRE_HIGHLIGHTS_THEME } from "@shared/tool-rendering/pierre-theme";
import GithubSlugger from "github-slugger";
import { createPortal } from "react-dom";
import { lazy, memo, Suspense, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CITATION_TOKEN_RE, parseCitationPath } from "@/lib/file-citation";
import { useMarkdownLinkHandler } from "@/lib/markdown-links";
import { FileCitationChip } from "@/components/editor/FileCitationChip";
import { hasInlineMarkdownHtml, prepareMarkdownHtml, restoreInlineHtml } from "@/lib/markdown-html";
import type { RichMarkdownProps } from "./rich-markdown";
import { UiBlock } from "./ui-block";

const MermaidBlock = lazy(() => import("./mermaid-block"));
const PortableMarkdown = lazy(() => import("./portable-markdown"));

const code = PIERRE_HIGHLIGHTS_THEME ? createHighlightsPlugin({ theme: PIERRE_HIGHLIGHTS_THEME }) : undefined;
const codeControls = { code: { copy: true, download: false } };
const slotAttribute = "data-operon-markdown-slot";
const citationPattern = new RegExp(CITATION_TOKEN_RE.source, "g");
const formattedTags = /<code\b[^>]*>[\s\S]*?<\/code>|<[^>]*>|[^<]+/g;
const textBlocks = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th"] as const;
const encodedEntities = /&(amp|lt|gt|quot|#x27|#39);/g;
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };

function citationSlot(token: string, rawPath: string, line: string, endLine?: string) {
  const path = parseCitationPath(rawPath.replace(encodedEntities, (_, entity: string) => entities[entity]));
  if (!path) return token;
  const data = escapeHtml(JSON.stringify({ path, line: Number(line), endLine: endLine ? Number(endLine) : undefined }));
  return '<span ' + slotAttribute + '="citation" data-slot-value="' + data + '"></span>';
}

function formatInlineText(html: string, citations: boolean, inlineHtml: boolean) {
  const hasCitations = citations && html.includes("【F:");
  const hasHtml = inlineHtml && hasInlineMarkdownHtml(html);
  if (!hasCitations && !hasHtml) return html;
  return html.replace(formattedTags, (part) => {
    if (part.startsWith("<")) return part;
    const content = hasCitations ? part.replace(citationPattern, citationSlot) : part;
    return hasHtml ? restoreInlineHtml(content) : content;
  });
}

function citeInlineCode(html: string) {
  const content = html.slice(html.indexOf(">") + 1, -"</code>".length);
  if (!content.startsWith("【F:")) return html;
  const match = [...content.matchAll(citationPattern)][0];
  return match?.[0] === content ? citationSlot(match[0], match[1], match[2], match[3]) : html;
}

function softBreaks(html: string) {
  return html.replace(/<br\b[^>]*>\n|\n/g, (part) => part === "\n" ? "<br>\n" : part);
}

function createComponents(citations: boolean, breaks: boolean, inlineHtml: boolean): Components {
  const components: Components = {
    table: (html) => '<div class="markdown-table-scroll">' + html + '</div>',
  };
  if (citations) components.inlineCode = citeInlineCode;
  const format = (html: string) => formatInlineText(html, citations, inlineHtml);
  if (citations || inlineHtml) {
    for (const tag of textBlocks) components[tag] = format;
  }
  if (breaks) {
    components.p = (html) => softBreaks(format(html));
    components.li = (html) => format(breakListItem(html));
  }
  return components;
}

function breakListItem(html: string) {
  // Paragraph hooks already handled loose lists. Restrict this to a tight
  // list item's inline content, ahead of any nested block.
  const block = html.search(/<(?:p|ol|ul|blockquote|div|pre|table)\b/);
  if (block !== -1 && html.startsWith("<p", html.indexOf(">") + 1)) return html;
  if (block === -1) return softBreaks(html);
  return softBreaks(html.slice(0, block).trimEnd()) + html.slice(block);
}

const baseRenderers: NonNullable<PluginConfig["renderers"]> = [{
  language: ["mermaid", "operon-html"],
  render: ({ code, language, isIncomplete }) => blockSlot(language, code, isIncomplete),
}];
const withUi: PluginConfig = {
  code,
  renderers: [...baseRenderers, { language: "ui", render: ({ code, isIncomplete }) => blockSlot("ui", code, isIncomplete) }],
};
const withoutUi: PluginConfig = { code, renderers: baseRenderers };

function blockSlot(kind: string, source: string, incomplete: boolean) {
  const value = escapeHtml(JSON.stringify({ source, incomplete }));
  return '<div ' + slotAttribute + '="' + kind + '" data-slot-value="' + value + '"></div>';
}

interface Slot {
  key: string;
  kind: string;
  value: string;
  container: HTMLElement;
}

const Words = memo(Markdown);

export default function WordsMessageMarkdown({
  children, className, uiBlocks = false, citations = false, headingIds = false,
  breaks = false, codeControls: showControls = true, ...stream
}: RichMarkdownProps) {
  const root = useRef<HTMLDivElement>(null);
  const onClick = useMarkdownLinkHandler();
  const [slots, setSlots] = useState<Slot[]>([]);
  const slotsRef = useRef<Slot[]>([]);
  const source = useMemo(() => prepareMarkdownHtml(children), [children]);
  const inlineHtml = hasInlineMarkdownHtml(source);
  const components = useMemo(() => createComponents(citations, breaks, inlineHtml), [citations, breaks, inlineHtml]);

  useLayoutEffect(() => {
    const scope = root.current;
    if (!scope) return;

    if (headingIds) {
      const slugger = new GithubSlugger();
      for (const heading of scope.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
        // The placeholders carry citation metadata even before React mounts.
        const label = heading.textContent ?? "";
        const id = slugger.slug(label);
        if (heading.id !== id) heading.id = id;
      }
    }

    const previous = slotsRef.current;
    const next = Array.from(scope.querySelectorAll<HTMLElement>("[" + slotAttribute + "]"), (host, index) => {
      const kind = host.getAttribute(slotAttribute) ?? "";
      const value = host.dataset.slotValue ?? "";
      const key = kind + ":" + index;
      const old = previous[index];
      const container = old?.key === key ? old.container : document.createElement(kind === "citation" ? "span" : "div");
      // Words owns the placeholder. The nested portal container is kept alive
      // when an updated pending block causes Words to replace its children.
      if (container.parentNode !== host) host.append(container);
      return old?.key === key && old.value === value ? old : { key, kind, value, container };
    });
    if (next.length !== previous.length || next.some((slot, index) => slot !== previous[index])) {
      slotsRef.current = next;
      setSlots(next);
    }
  }, [source, headingIds, components, uiBlocks, showControls, stream.isAnimating, stream.mode, stream.parseIncompleteMarkdown]);

  return (
    <div ref={root} onClick={onClick}>
      <Words
        {...stream}
        className={className}
        cjk math components={components}
        plugins={uiBlocks ? withUi : withoutUi}
        controls={showControls ? codeControls : false} lineNumbers={false}
      >
        {source}
      </Words>
      {slots.map((slot) => createPortal(<MarkdownSlot slot={slot} controls={showControls} />, slot.container, slot.key))}
    </div>
  );
}

const MarkdownSlot = memo(function MarkdownSlot({ slot, controls }: { slot: Slot; controls: boolean }) {
  if (slot.kind === "citation") {
    const ref = JSON.parse(slot.value) as { path: string; line: number; endLine?: number };
    return <FileCitationChip {...ref} />;
  }
  const { source, incomplete } = JSON.parse(slot.value) as { source: string; incomplete: boolean };
  if (slot.kind === "ui") return <UiBlock code={source} />;
  if (slot.kind === "mermaid") {
    return <Suspense><MermaidBlock source={source} incomplete={incomplete} controls={controls} /></Suspense>;
  }
  // Always sanitize legacy HTML, including an explicitly authored fence.
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { return <pre>{source}</pre>; }
  return typeof raw === "string"
    ? <Suspense><PortableMarkdown citations headingIds>{raw}</PortableMarkdown></Suspense>
    : null;
});
