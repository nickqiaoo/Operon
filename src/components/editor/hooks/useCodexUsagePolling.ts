import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CodexRateLimits } from '../utils/chatMetadata';

const USAGE_POLL_MS = 120_000;

/** Account-scoped quota, shared by the top bar and empty or existing chats. */
export function useCodexUsagePolling(enabled = true, isGenerating = false) {
  const query = useQuery({
    queryKey: ['ai', 'codex-usage'],
    queryFn: async (): Promise<CodexRateLimits | null> => {
      const result = await api.aiGetCodexUsage();
      return result.success ? (result.data ?? null) : null;
    },
    enabled,
    retry: false,
    staleTime: USAGE_POLL_MS,
    refetchInterval: enabled ? USAGE_POLL_MS : false,
    refetchIntervalInBackground: false,
  });

  const { refetch } = query;
  const wasGenerating = useRef(isGenerating);
  useEffect(() => {
    const turnJustFinished = wasGenerating.current && !isGenerating;
    wasGenerating.current = isGenerating;
    if (enabled && turnJustFinished) void refetch();
  }, [enabled, isGenerating, refetch]);

  return query;
}
