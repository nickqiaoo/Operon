
import { memo, useCallback, useMemo, type AnchorHTMLAttributes } from "react";
import { safeCode } from "@/lib/streamdown-code";
import { openExternalUrl } from "@/lib/open-external";
import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown, defaultUrlTransform } from "streamdown";
import rehypeSlug from "rehype-slug";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { cn } from "@/lib/utils";
import { openWorkspaceFilePreview } from "@/lib/workspace-file-preview";
import { useCodeBlockCopy } from "@/hooks/useCodeBlockCopy";
import { remarkFileCitations } from "@/lib/remark-file-citations";
import { InlineFileCode } from "@/components/editor/FileCitationChip";

const code = safeCode;

const rehypePlugins: [typeof rehypeSlug] = [rehypeSlug];
// File citations (【F:path†L…】) are surfaced by remarkFileCitations; clicking an
// inline-code citation is handled by the InlineFileCode component.
// remarkGfm must be included explicitly: passing a custom remarkPlugins array
// replaces Streamdown's default set (which bundles gfm), so without it GFM
// tables/strikethrough/task-lists degrade to plain paragraphs.
const remarkPluginsBase: PluggableList = [remarkGfm, remarkFileCitations];
const remarkPluginsWithBreaks: PluggableList = [remarkGfm, remarkFileCitations, remarkBreaks];

/** Allow absolute file paths through URL sanitization. */
const urlTransform: typeof defaultUrlTransform = (url, key, node) => {
    if (url.startsWith("/")) return url;
    return defaultUrlTransform(url, key, node) ?? url;
};

function MarkdownLink({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
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

        // Local file path (absolute path like /Users/...)
        if (href.startsWith("/")) {
            const hash = href.match(/#L(\d+)/);
            openWorkspaceFilePreview(
                href.split("#")[0],
                hash ? { line: Number.parseInt(hash[1], 10) } : undefined
            );
        }
    }, [href]);

    return (
        <a href={href} onClick={handleClick} {...props}>
            {children}
        </a>
    );
}

const markdownComponents = { a: MarkdownLink, inlineCode: InlineFileCode };

export interface MarkdownRendererProps {
    content: string;
    className?: string;
    /**
     * Treat single newlines as hard line breaks (GitHub-style README rendering).
     * Off by default so the chat renderer keeps standard CommonMark paragraph
     * collapsing.
     */
    breaks?: boolean;
}

export const MarkdownRenderer = memo(({ content, className, breaks }: MarkdownRendererProps) => {
    const codeBlockCopyRef = useCodeBlockCopy();
    const remarkPlugins = useMemo<PluggableList>(
        () => (breaks ? remarkPluginsWithBreaks : remarkPluginsBase),
        [breaks]
    );

    return (
        <div ref={codeBlockCopyRef}>
            <Streamdown
                className={cn(
                    "prose prose-sm dark:prose-invert max-w-none w-full",
                    "prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0",
                    // Conversational heading scale: chat output is a reply, not a
                    // document — headings differ from body by one step + weight,
                    // never by poster-size type.
                    "prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-1.5 prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-h4:text-sm",
                    "prose-p:leading-[1.4] prose-li:leading-[1.35] prose-p:my-0.5 prose-li:my-0",
                    "break-words",
                    className
                )}
                plugins={{ code, mermaid, math, cjk }}
                controls={{ table: false, code: false }}
                rehypePlugins={rehypePlugins}
                remarkPlugins={remarkPlugins}
                urlTransform={urlTransform}
                components={markdownComponents}
            >
                {content}
            </Streamdown>
        </div>
    );
});

MarkdownRenderer.displayName = "MarkdownRenderer";
