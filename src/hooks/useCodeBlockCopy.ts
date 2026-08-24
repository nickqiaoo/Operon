"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Hook that adds copy buttons to all Streamdown code blocks within a container.
 * Uses event delegation for efficiency - one handler on the container.
 */
export function useCodeBlockCopy() {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClick = useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const btn = target.closest("[data-code-copy-btn]") as HTMLElement | null;
    if (!btn) return;

    const codeBlock = btn.closest('[data-streamdown="code-block"]');
    if (!codeBlock) return;

    const pre = codeBlock.querySelector("pre");
    if (!pre) return;

    const code = pre.textContent || "";
    void navigator.clipboard.writeText(code).then(() => {
      btn.setAttribute("data-copied", "true");
      setTimeout(() => btn.removeAttribute("data-copied"), 2000);
    });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("click", handleClick);
    return () => container.removeEventListener("click", handleClick);
  }, [handleClick]);

  // Inject copy buttons into code blocks after render
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const injectButtons = () => {
      const codeBlocks = container.querySelectorAll(
        '[data-streamdown="code-block"]'
      );

      for (const block of codeBlocks) {
        if (block.querySelector("[data-code-copy-btn]")) continue;

        const header = block.querySelector(
          '[data-streamdown="code-block-header"]'
        );
        if (!header) continue;

        const btn = document.createElement("button");
        btn.setAttribute("data-code-copy-btn", "");
        btn.type = "button";
        btn.title = "Copy Code";
        // SVG icons: copy icon + check icon (shown via CSS data-copied)
        btn.innerHTML = `<svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><svg class="check-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
        header.appendChild(btn);
      }
    };

    // Run on mount and observe for dynamic content changes (streaming)
    injectButtons();

    const observer = new MutationObserver(injectButtons);
    observer.observe(container, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);

  return containerRef;
}
