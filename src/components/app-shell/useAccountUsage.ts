import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import type { ClaudeRateLimits, CodexRateLimits, RateLimitSnapshot } from '@/components/editor/utils/chatMetadata';

/**
 * Account quota polls for the window's top bar. Both are account-scoped, so
 * they run regardless of which provider the open chat uses — the bar is a
 * property of the app, not of the conversation.
 *
 * Slow on purpose. For Claude this shares its cache key with the composer
 * badge, which `rate_limit_event` pushes are folded into mid-turn, so the bar
 * follows a running turn without polling for it. Codex has no such push, but
 * the runtime caches the read, and a quota window moves too slowly to be worth
 * asking about more often.
 */
const USAGE_POLL_MS = 120_000;

const claudeUsageQueryKey = ['ai', 'claude-usage'] as const;
const codexUsageQueryKey = ['ai', 'codex-usage'] as const;

/** One provider's two headline windows, already normalized to 0-100. */
export interface ProviderUsage {
  providerId: string;
  /** The short window (5 hours on both providers today). */
  shortPercent?: number;
  /** The long window (weekly on both). */
  longPercent?: number;
}

/** Percentages arrive as 0-1 from some sources and 0-100 from others. */
const toPercent = (value: number | undefined): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, normalized));
};

const claudeUsage = (limits: ClaudeRateLimits | null): ProviderUsage | null => {
  const shortPercent = toPercent(limits?.windows?.five_hour?.utilization);
  const longPercent = toPercent(limits?.windows?.seven_day?.utilization);
  if (shortPercent === undefined && longPercent === undefined) return null;
  return { providerId: 'claude-code', shortPercent, longPercent };
};

/** A day, in minutes — the line between "short window" and "weekly". */
const SHORT_WINDOW_MAX_MINS = 24 * 60;

/**
 * Codex reports one bucket per pool. The plan bucket (`codex`) is the one that
 * owns both headline windows — primary is its 5-hour, secondary its weekly —
 * so it is preferred outright. Falling back to scanning every bucket would mix
 * the reserve pool's weekly in with the plan's, which are different budgets
 * that happen to share a duration.
 */
const codexUsage = (limits: CodexRateLimits | null): ProviderUsage | null => {
  const plan: RateLimitSnapshot | undefined =
    limits?.rateLimitsByLimitId?.codex ??
    (limits?.rateLimits?.limitId === 'codex' ? limits.rateLimits : undefined) ??
    limits?.rateLimits ??
    undefined;
  if (!plan) return null;

  const windows = [plan.primary, plan.secondary].filter((window) => window != null);
  const short = windows.find(
    (window) => (window.windowDurationMins ?? 0) > 0 && window.windowDurationMins! <= SHORT_WINDOW_MAX_MINS,
  );
  const long = windows.find((window) => (window.windowDurationMins ?? 0) > SHORT_WINDOW_MAX_MINS);

  const shortPercent = toPercent(short?.usedPercent);
  const longPercent = toPercent(long?.usedPercent);
  if (shortPercent === undefined && longPercent === undefined) return null;
  return { providerId: 'codex', shortPercent, longPercent };
};

export function useAccountUsage(): {
  providers: ProviderUsage[];
  isRefreshing: boolean;
  refresh: () => void;
} {
  const claude = useQuery({
    queryKey: claudeUsageQueryKey,
    queryFn: async (): Promise<ClaudeRateLimits | null> => {
      const result = await api.aiGetClaudeUsage();
      return result.success ? (result.data ?? null) : null;
    },
    retry: false,
    staleTime: USAGE_POLL_MS,
    refetchInterval: USAGE_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const codex = useQuery({
    queryKey: codexUsageQueryKey,
    queryFn: async (): Promise<CodexRateLimits | null> => {
      const result = await api.aiGetCodexUsage();
      return result.success ? (result.data ?? null) : null;
    },
    retry: false,
    staleTime: USAGE_POLL_MS,
    refetchInterval: USAGE_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const queryClient = useQueryClient();
  const [isForcing, setIsForcing] = useState(false);

  // Fetches and writes the cache directly rather than going through
  // `refetchQueries`, for two reasons. A refetch re-runs the query's own
  // `queryFn`, which takes no arguments and so cannot ask for `force` — and the
  // Claude key is shared with the composer badge's query, whose `queryFn` is
  // declared in another file, so which of the two a refetch would run is not
  // something this hook can say. Fetching here makes both answerable.
  const refresh = useCallback(() => {
    if (isForcing) return;
    setIsForcing(true);
    void (async () => {
      try {
        const [claudeResult, codexResult] = await Promise.all([
          api.aiGetClaudeUsage(true),
          api.aiGetCodexUsage(true),
        ]);
        // A failed read leaves the last good number on screen: the windows are
        // still whatever they were, and blanking the bar would report a
        // temporary read failure as an account with no quota.
        if (claudeResult.success) {
          queryClient.setQueryData(claudeUsageQueryKey, claudeResult.data ?? null);
        }
        if (codexResult.success) {
          queryClient.setQueryData(codexUsageQueryKey, codexResult.data ?? null);
        }
      } finally {
        setIsForcing(false);
      }
    })();
  }, [isForcing, queryClient]);

  // A provider with nothing to report is left out rather than shown empty: not
  // signed in, no CLI, or a plan without limits are all "there is no number
  // here", and a placeholder would only take space in the title bar.
  const providers = [claudeUsage(claude.data ?? null), codexUsage(codex.data ?? null)].filter(
    (usage) => usage != null,
  );

  return {
    providers,
    isRefreshing: isForcing || claude.isFetching || codex.isFetching,
    refresh,
  };
}
