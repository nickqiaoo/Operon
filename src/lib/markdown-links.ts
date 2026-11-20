import { useCallback, type MouseEvent } from "react";
import { useFileOpenHandler, type FileOpenHandler } from "@/lib/file-open-context";
import { openExternalUrl } from "@/lib/open-external";
import { decodeLocalPath } from "@/lib/reply-images";

function activateMarkdownLink(href: string, openFile: FileOpenHandler | null, root: HTMLElement) {
  if (href.startsWith("#")) {
    const id = decodeLocalPath(href.slice(1));
    const target = root.querySelector(`#${CSS.escape(id)}`) ?? document.getElementById(id);
    target?.scrollIntoView({ behavior: "smooth" });
  } else if (href.startsWith("http://") || href.startsWith("https://")) {
    openExternalUrl(href);
  } else if (href.startsWith("/") && !href.startsWith("//")) {
    const match = href.match(/#L(\d+)$/);
    openFile?.(decodeLocalPath(href.split("#")[0]), match ? { line: Number.parseInt(match[1], 10) } : undefined);
  }
}

export function useMarkdownLinkHandler() {
  const openFile = useFileOpenHandler();
  return useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const link = event.target.closest('a[data-markdown="a"][href]');
    if (!link || !event.currentTarget.contains(link)) return;
    const href = link.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    activateMarkdownLink(href, openFile, event.currentTarget);
  }, [openFile]);
}
