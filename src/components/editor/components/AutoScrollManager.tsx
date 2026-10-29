import { useLayoutEffect, useRef } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';

interface AutoScrollManagerProps {
  messageCount: number;
  historyLoaded: boolean;
}

/**
 * Jumps to the newest message once history has loaded. Following the stream
 * from there is left to the library: it tracks content growth itself and lets
 * go as soon as the reader scrolls up. A second follower driven by each token
 * (with the library's "within 70px" `isAtBottom`) re-locked readers easing
 * down near the end and fought their wheel/trackpad scroll.
 */
export function AutoScrollManager({ messageCount, historyLoaded }: AutoScrollManagerProps) {
  const { scrollToBottom } = useStickToBottomContext();
  const hasScrolledForHistoryRef = useRef(false);

  useLayoutEffect(() => {
    if (historyLoaded && messageCount > 0 && !hasScrolledForHistoryRef.current) {
      hasScrolledForHistoryRef.current = true;
      requestAnimationFrame(() => {
        scrollToBottom({ animation: 'instant' });
      });
    }
  }, [historyLoaded, messageCount, scrollToBottom]);

  return null;
}
