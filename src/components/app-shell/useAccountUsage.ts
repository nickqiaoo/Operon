import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { aiUsageKeys } from '@/lib/chat-queries';
import { useCodexUsagePolling } from '@/components/editor/hooks/useCodexUsagePolling';
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


/** One provider's two headline windows, already normalized to 0-100. */
export interface ProviderUsage {
  providerId: string;
  /** The short window (5 hours on both providers today). */
  shortPercent?: number;
  /** The long window (weekly on both). */
  longPercent?: number;
  /** When each window resets, epoch ms. */
  shortResetsAt?: number;
  longResetsAt?: number;
  /** Plan name as the provider reports it ('max', 'plus', …). */
  plan?: string;
  /** Codex credits on top of the plan, when the account has any. */
  credits?: { unlimited: boolean; balance?: string };
}

/**
 * Both sources already report 0-100: Codex's `usedPercent` is a percentage, and
 * the runtime brings Claude's pushed 0-1 fractions onto the poll's 0-100 scale.
 * Don't guess a fraction from the size: `<= 1` turned Codex's 1% into 100%.
 */
const toPercent = (value: number | undefined): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
};

/** Providers report epoch seconds or milliseconds; anything past 2001 in ms is ms. */
const toEpochMs = (value: number | null | undefined): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 1_000_000_000_000 ? value : value * 1000;
};

const claudeUsage = (limits: ClaudeRateLimits | null): ProviderUsage | null => {
  const short = limits?.windows?.five_hour;
  const long = limits?.windows?.seven_day;
  const shortPercent = toPercent(short?.utilization);
  const longPercent = toPercent(long?.utilization);
  if (shortPercent === undefined && longPercent === undefined) return null;
  return {
    providerId: 'claude-code',
    shortPercent,
    longPercent,
    shortResetsAt: toEpochMs(short?.resetsAt),
    longResetsAt: toEpochMs(long?.resetsAt),
    plan: limits?.subscriptionType || undefined,
  };
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
  const credits = plan.credits;
  return {
    providerId: 'codex',
    shortPercent,
    longPercent,
    shortResetsAt: toEpochMs(short?.resetsAt),
    longResetsAt: toEpochMs(long?.resetsAt),
    plan: plan.planType ?? undefined,
    credits:
      credits && (credits.unlimited || credits.hasCredits)
        ? { unlimited: credits.unlimited, balance: credits.balance ?? undefined }
        : undefined,
  };
};

export function useAccountUsage(): {
  providers: ProviderUsage[];
} {
  const claude = useQuery({
    queryKey: aiUsageKeys.claude(),
    queryFn: async (): Promise<ClaudeRateLimits | null> => {
      const result = await api.aiGetClaudeUsage();
      // A failed read throws instead of resolving to null: React Query then
      // keeps the last good reading (and retries soon), where a null would
      // overwrite it and drop the provider from the rail until the next poll.
      if (!result.success) throw new Error(result.error ?? 'Claude usage unavailable');
      return result.data ?? null;
    },
    retry: 2,
    retryDelay: (attempt) => Math.min(5_000 * 2 ** attempt, 30_000),
    staleTime: USAGE_POLL_MS,
    refetchInterval: USAGE_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const codex = useCodexUsagePolling();

  // A provider with nothing to report is left out rather than shown empty: not
  // signed in, no CLI, or a plan without limits are all "there is no number
  // here", and a placeholder would only take space in the title bar.
  const providers = [claudeUsage(claude.data ?? null), codexUsage(codex.data ?? null)].filter(
    (usage) => usage != null,
  );

  // No manual refresh: both windows poll every two minutes, which is finer
  // than a 5-hour / weekly budget moves.
  return { providers };
}
