import { useEffect, type RefObject } from "react";

/**
 * Drive the `scroll-fade-y` edge fades from script instead of its scroll-linked
 * animation.
 *
 * A scroll timeline is sampled once per frame, before layout, as a fraction of
 * the scroll range. When content shrinks (folding a tool group), the range
 * shrinks in that frame's layout while the fade still applies the old fraction:
 * the top fade, which should stay full while scrolled down, painted narrower
 * for every frame of the fold, and the text under it flickered. Measured after
 * layout, the sizes are right in the frame that paints them.
 *
 * Mounted from a passive effect on purpose: it creates its ResizeObserver after
 * the scroller's own (registered by children, and by layout effects), so its
 * callback runs last in each delivery and reads the offset they settled on.
 */
export function useScrollFade(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!enabled || !viewport || !content) return;
    const size = Number.parseFloat(getComputedStyle(viewport).getPropertyValue("--scroll-fade-size")) || 24;

    // Same curves as the keyframes: each edge reaches full size within the
    // first `size` px of content beyond it, and an edge with none has no fade.
    const update = () => {
      const below = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
      viewport.style.setProperty("--scroll-fade-top", `${Math.min(Math.max(viewport.scrollTop, 0), size)}px`);
      viewport.style.setProperty("--scroll-fade-bottom", `${Math.min(Math.max(below, 0), size)}px`);
    };

    viewport.style.animation = "none";
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(content, { box: "border-box" });
    viewport.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", update);
      viewport.style.removeProperty("animation");
      viewport.style.removeProperty("--scroll-fade-top");
      viewport.style.removeProperty("--scroll-fade-bottom");
    };
  }, [scrollRef, contentRef, enabled]);
}
