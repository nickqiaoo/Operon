import { useLayoutEffect, type RefObject } from "react";

/** Preserve the visible row while older messages mount or change height. */
export function useReadingScrollAnchor(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  followingRef: RefObject<boolean>,
  programmaticScrollRef: RefObject<boolean>,
) {
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    let anchor: { element: HTMLElement; offset: number } | null = null;
    const offsetInContent = (element: HTMLElement) =>
      element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;

    const capture = () => {
      if (followingRef.current && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2) {
        anchor = null;
        return;
      }
      const bounds = viewport.getBoundingClientRect();
      for (const element of content.children) {
        if (!(element instanceof HTMLElement) || !element.dataset.messageId) continue;
        const rect = element.getBoundingClientRect();
        if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
          anchor = { element, offset: rect.top - bounds.top + viewport.scrollTop };
          return;
        }
      }
      anchor = null;
    };

    const restore = () => {
      if (programmaticScrollRef.current) {
        anchor = null;
        return;
      }
      if (!anchor?.element.isConnected) return;
      // Content coordinates exclude finger/wheel movement since the snapshot.
      // A viewport-relative snapshot would undo that movement on a prepend.
      const offset = offsetInContent(anchor.element);
      const delta = offset - anchor.offset;
      if (Math.abs(delta) > 0.5) viewport.scrollTop += delta;
      anchor.offset = offset;
    };
    const update = () => {
      restore();
      if (!programmaticScrollRef.current) capture();
    };
    const resumeReading = () => {
      programmaticScrollRef.current = false;
      capture();
    };

    const resizeObserver = new ResizeObserver(update);
    // Border box: padding (floating chrome insets) moves every row too.
    resizeObserver.observe(content, { box: "border-box" });
    const mutationObserver = new MutationObserver(update);
    mutationObserver.observe(content, { childList: true });
    viewport.addEventListener("scroll", update, { passive: true });
    viewport.addEventListener("scrollend", resumeReading);
    viewport.addEventListener("wheel", resumeReading, { passive: true });
    viewport.addEventListener("touchmove", resumeReading, { passive: true });
    viewport.addEventListener("pointerdown", resumeReading, { passive: true });
    viewport.addEventListener("keydown", resumeReading);
    capture();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      viewport.removeEventListener("scroll", update);
      viewport.removeEventListener("scrollend", resumeReading);
      viewport.removeEventListener("wheel", resumeReading);
      viewport.removeEventListener("touchmove", resumeReading);
      viewport.removeEventListener("pointerdown", resumeReading);
      viewport.removeEventListener("keydown", resumeReading);
    };
  }, [scrollRef, contentRef, followingRef, programmaticScrollRef]);
}
