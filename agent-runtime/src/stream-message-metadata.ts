import type { LanguageModelUsage } from 'ai'
import {
  getCompactedFromProviderMetadata,
  getCodexAccountFromProviderMetadata,
  getCodexRateLimitsFromProviderMetadata,
  getContextUsageFromProviderMetadata,
} from './stream-utils.js'
import type { CodexGoal } from './providers/codex/sdk/protocol/index.js'
import type { RuntimeUsageLimits } from './types.js'

export type StreamMessageMetadata = {
  usage?: LanguageModelUsage
  contextUsage?: Record<string, number>
  detailedContextUsage?: Record<string, unknown>
  codexAccount?: Record<string, unknown>
  codexRateLimits?: Record<string, unknown>
  /**
   * Account quota pushed by Claude's `rate_limit_event`, forwarded live so the
   * badge moves with the turn instead of waiting for the next poll.
   */
  claudeRateLimits?: RuntimeUsageLimits
  compacted?: Record<string, unknown>
  contextCompaction?: {
    id: string
    status: 'in_progress' | 'completed'
  }
  /** Live thread-goal state forwarded from `thread/goal/updated`. */
  codexGoal?: CodexGoal
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
    ...(codexAccount ? { codexAccount } : {}),
    ...(codexRateLimits ? { codexRateLimits } : {}),
    ...(compacted ? { compacted } : {}),
  }
}
