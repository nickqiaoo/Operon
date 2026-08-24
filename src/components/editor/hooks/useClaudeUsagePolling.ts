import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DetailedContextUsage } from '@/types/context-usage';
import type { ClaudeRateLimits } from '../utils/chatMetadata';

const CONTEXT_USAGE_POLL_MS = 5_000;
const CLAUDE_USAGE_POLL_MS = 30_000;

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
  // running during generation too. It tracks spend by any client on the account
  // (another Claude Code, phone, another workspace) and window resets, neither
  // of which this tab's turns can tell us about.
  const { data: claudeRateLimits = null } = useQuery({
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

  // Context usage is per-session and computed locally, so it is accurate the
  // moment a turn ends — refresh it right away instead of waiting a full tick.
  const wasGeneratingRef = useRef(isGenerating);
  useEffect(() => {
    const turnJustFinished = wasGeneratingRef.current && !isGenerating;
    wasGeneratingRef.current = isGenerating;
    if (!turnJustFinished || !hasContextSession) return;
    void refetchContextUsage();
  }, [hasContextSession, isGenerating, refetchContextUsage]);

  return { detailedContextUsage, claudeRateLimits };
}
