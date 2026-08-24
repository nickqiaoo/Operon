import { useLayoutEffect, useRef } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';

interface AutoScrollManagerProps {
  status: string;
  messageCount: number;
  lastMessageId?: string;
  lastMessageTextSize: number;
  historyLoaded: boolean;
}

export function AutoScrollManager({
  status,
  messageCount,
  lastMessageId,
  lastMessageTextSize,
  historyLoaded,
}: AutoScrollManagerProps) {
  const { scrollToBottom, isAtBottom } = useStickToBottomContext();
  const hasScrolledForHistoryRef = useRef(false);

  useLayoutEffect(() => {
    if (historyLoaded && messageCount > 0 && !hasScrolledForHistoryRef.current) {
      hasScrolledForHistoryRef.current = true;
      requestAnimationFrame(() => {
        scrollToBottom({ animation: 'instant' });
      });
    }
  }, [historyLoaded, messageCount, scrollToBottom]);

  const lastMessageKey = `${messageCount}:${lastMessageId ?? 'msg'}:${lastMessageTextSize}`;

  useLayoutEffect(() => {
    if (status !== 'streaming' && status !== 'submitted') return;
    if (!isAtBottom) return;
    const frame = requestAnimationFrame(() => {
      scrollToBottom({ animation: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [lastMessageKey, status, scrollToBottom, isAtBottom]);

  return null;
}
