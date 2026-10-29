import type { LanguageModelUsage } from 'ai'
import {
  getCompactedFromProviderMetadata,
  getCodexAccountFromProviderMetadata,
  getCodexRateLimitsFromProviderMetadata,
  getContextUsageFromProviderMetadata,
} from './stream-utils.js'
import type { RuntimeGoal, RuntimeUsageLimits } from './types.js'

/**
 * What a session's `message-metadata` parts carry. The top-level fields mean
 * the same on every provider; what only one provider reports sits under its id.
 */
export type StreamMessageMetadata = {
  usage?: LanguageModelUsage
  contextUsage?: Record<string, number>
  compacted?: Record<string, unknown>
  contextCompaction?: {
    id: string
    status: 'in_progress' | 'completed'
  }
  /** Live thread-goal state (`features.goal`), sent whenever it changes. */
  goal?: RuntimeGoal | null
  codex?: {
    /** The signed-in account (ChatGPT plan or API key). */
    account?: Record<string, unknown>
    /** Rate-limit buckets as the app-server reports them. */
    rateLimits?: Record<string, unknown>
  }
  'claude-code'?: {
    /**
     * Account quota pushed by Claude's `rate_limit_event`, forwarded live so a
     * badge can move with the turn instead of waiting for the next poll.
     */
    rateLimits?: RuntimeUsageLimits
  }
}

export const buildStreamMessageMetadata = ({
  providerMetadata,
  usage,
}: {
  providerMetadata: unknown
  usage: LanguageModelUsage | undefined
}): StreamMessageMetadata => {
  const compacted = getCompactedFromProviderMetadata(providerMetadata)
  const codexAccount = getCodexAccountFromProviderMetadata(providerMetadata)
  const codexRateLimits = getCodexRateLimitsFromProviderMetadata(providerMetadata)
  const contextUsage = getContextUsageFromProviderMetadata(providerMetadata)

  return {
    ...(usage ? { usage } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(codexAccount || codexRateLimits
      ? {
          codex: {
            ...(codexAccount ? { account: codexAccount } : {}),
            ...(codexRateLimits ? { rateLimits: codexRateLimits } : {}),
          },
        }
      : {}),
    ...(compacted ? { compacted } : {}),
  }
}
