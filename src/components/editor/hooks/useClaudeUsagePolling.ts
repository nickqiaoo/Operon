import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DetailedContextUsage } from '@/types/context-usage';
import type { ClaudeRateLimits } from '../utils/chatMetadata';

const CONTEXT_USAGE_POLL_MS = 5_000;
/**
 * Quota is now pushed onto the live stream as it moves (`rate_limit_event`, one
 * per 1% step), so this poll no longer carries the live number — it covers what
 * a push cannot see: spend by other clients (phone, another workspace, another
 * Claude Code) and windows resetting while this app sends nothing. Both are slow
 * relative to a turn, so it runs at a fraction of the old 30s.
 */
const CLAUDE_USAGE_POLL_MS = 120_000;

const claudeUsageQueryKey = ['ai', 'claude-usage'] as const;
const contextUsageQueryKey = (chatId: number) => ['ai', 'context-usage', chatId] as const;

interface ClaudeUsagePollingOptions {
  chatId?: number;
  /** Gates the subscription-quota poll — that number only exists for Claude. */
  isClaudeCode: boolean;
  /**
   * Gates the context-breakdown poll. A provider capability rather than an id
   * check: Claude Code answers it from its SDK, the Operon agent from the
   * engine's own turn-boundary snapshot, and others simply don't advertise it.
   */
  supportsContextUsage: boolean;
  isActive: boolean;
  isGenerating: boolean;
  /**
   * Quota pushed onto the live stream by the turn that is streaming right now,
   * or null. Folded into the same cache the poll writes, so the badge reads one
   * value from one place — see the note on the effect below.
   */
  pushedRateLimits?: ClaudeRateLimits | null;
}

/**
 * Keeps slow control requests outside the message stream. Subscription quota is
 * account-scoped and shared by every mounted chat; detailed context usage
 * remains chat-scoped.
 */
export function useClaudeUsagePolling({
  chatId,
  isClaudeCode,
  supportsContextUsage,
  isActive,
  isGenerating,
  pushedRateLimits,
}: ClaudeUsagePollingOptions): {
  detailedContextUsage: DetailedContextUsage | null;
  claudeRateLimits: ClaudeRateLimits | null;
} {
  const hasContextSession = supportsContextUsage && chatId !== undefined;
  const shouldPollContext = hasContextSession && isActive;

  const {
    data: detailedContextUsage = null,
    refetch: refetchContextUsage,
  } = useQuery({
    queryKey: contextUsageQueryKey(chatId ?? 0),
    queryFn: async (): Promise<DetailedContextUsage | null> => {
      if (chatId === undefined) return null;
      const result = await api.aiGetContextUsage(chatId);
      return result.success ? (result.data ?? null) : null;
    },
    enabled: shouldPollContext,
    retry: false,
    staleTime: CONTEXT_USAGE_POLL_MS,
    refetchInterval: shouldPollContext && isGenerating ? CONTEXT_USAGE_POLL_MS : false,
    refetchIntervalInBackground: false,
  });

  // Quota is served by a dedicated chat-less probe process, so it needs no open
  // session and cannot contend with the message stream — one plain interval,
  // running during generation too. The probe's snapshot is also what pushed
  // `rate_limit_event` updates are folded into, so this poll returns those
  // without waiting for its own round trip.
  const { data: claudeRateLimits = null, refetch: refetchClaudeUsage } = useQuery({
    queryKey: claudeUsageQueryKey,
    queryFn: async (): Promise<ClaudeRateLimits | null> => {
      const result = await api.aiGetClaudeUsage();
      return result.success ? (result.data ?? null) : null;
    },
    enabled: isClaudeCode && isActive,
    retry: false,
    staleTime: CLAUDE_USAGE_POLL_MS,
    refetchInterval: isClaudeCode && isActive ? CLAUDE_USAGE_POLL_MS : false,
    refetchIntervalInBackground: false,
  });

  // Write the push into the poll's cache instead of letting the UI choose
  // between two sources. Switching sources is what makes a badge jump: at the
  // instant a turn ends the stream value disappears, and whatever the poll last
  // fetched — up to two minutes old — would show through until the refetch
  // below lands. Folding the push in means the cache is never behind what the
  // user has already seen, so the handover changes nothing on screen.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!pushedRateLimits) return;
    queryClient.setQueryData(claudeUsageQueryKey, pushedRateLimits);
  }, [pushedRateLimits, queryClient]);

  // Both numbers are refreshed the moment a turn ends rather than on the next
  // tick. Context usage because it is computed locally and is accurate straight
  // away; quota to pick up what a push cannot report — spend by other clients —
  // now that this turn's own usage is already in the cache.
  const wasGeneratingRef = useRef(isGenerating);
  useEffect(() => {
    const turnJustFinished = wasGeneratingRef.current && !isGenerating;
    wasGeneratingRef.current = isGenerating;
    if (!turnJustFinished) return;
    if (hasContextSession) void refetchContextUsage();
    if (isClaudeCode) void refetchClaudeUsage();
  }, [hasContextSession, isClaudeCode, isGenerating, refetchClaudeUsage, refetchContextUsage]);

  return { detailedContextUsage, claudeRateLimits };
}
