import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Anthropic prompt caches live 5 minutes by default and 1 hour with the extended
 * TTL, which is what Claude Code sessions run on. The API never reports how much
 * lifetime a cache entry has left — `cache_read_input_tokens` only tells you
 * after the fact whether a request hit — so the only way to know a session has
 * gone cold is to time it client-side from the end of the last turn.
 */
export const CLAUDE_CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheExpiryNoticeOptions {
  /** Only Claude sessions have a prompt cache we can reason about. */
  enabled: boolean;
  isGenerating: boolean;
  /**
   * Server-side timestamp of the last persisted message (`chats.updated_at`),
   * which the server stamps when the assistant reply lands — not when the turn
   * started, so a long turn doesn't age the cache early. Lets a conversation
   * reopened from history know it went cold while the tab was closed.
   */
  lastMessageAt?: number | null;
}

/**
 * Warns that this conversation's prompt cache has expired while the user was
 * idle, so the next message re-reads the whole context at full price.
 *
 * The window is armed from whichever end-of-turn we know about — one observed
 * live in this mount, or `lastMessageAt` when the chat is reopened from history
 * — and disarmed the moment the next turn starts (that turn writes the cache
 * again).
 */
export function useCacheExpiryNotice({ enabled, isGenerating, lastMessageAt }: CacheExpiryNoticeOptions) {
  const [lastTurnEndedAt, setLastTurnEndedAt] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const wasGeneratingRef = useRef(isGenerating);

  useEffect(() => {
    const wasGenerating = wasGeneratingRef.current;
    wasGeneratingRef.current = isGenerating;
    if (!enabled) return;

    if (isGenerating && !wasGenerating) {
      // A new turn refreshes the cache: drop the pending timer and any notice
      // the previous idle stretch produced.
      setLastTurnEndedAt(null);
      setExpired(false);
      setDismissed(false);
      return;
    }
    if (!isGenerating && wasGenerating) {
      setLastTurnEndedAt(Date.now());
    }
  }, [enabled, isGenerating]);

  useEffect(() => {
    // Seed from history so reopening an old conversation still warns. Never
    // overwrites a turn this mount actually watched finish (that one is more
    // precise), and stays out of the way mid-turn — the cache is being written
    // right now, and the fetched timestamp predates it anyway.
    if (!enabled || isGenerating || lastMessageAt == null) return;
    setLastTurnEndedAt((current) => current ?? lastMessageAt);
  }, [enabled, isGenerating, lastMessageAt]);

  useEffect(() => {
    if (enabled) return;
    setLastTurnEndedAt(null);
    setExpired(false);
    setDismissed(false);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || lastTurnEndedAt === null || expired) return;

    const expiresAt = lastTurnEndedAt + CLAUDE_CACHE_TTL_MS;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }

    const timer = window.setTimeout(() => setExpired(true), remaining);
    // Timers are throttled in background tabs and stop entirely across machine
    // sleep, so re-read the wall clock whenever the window comes back.
    const recheck = () => {
      if (Date.now() >= expiresAt) setExpired(true);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', recheck);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', recheck);
    };
  }, [enabled, expired, lastTurnEndedAt]);

  const dismiss = useCallback(() => setDismissed(true), []);

  return { showCacheExpiredNotice: expired && !dismissed, dismissCacheExpiredNotice: dismiss };
}
