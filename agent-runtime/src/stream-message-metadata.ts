import type { LanguageModelUsage } from 'ai'
import {
  getCompactedFromProviderMetadata,
  getCodexAccountFromProviderMetadata,
  getCodexRateLimitsFromProviderMetadata,
  getContextUsageFromProviderMetadata,
} from './stream-utils.js'
import type { CodexGoal } from './providers/codex/sdk/protocol/index.js'

export type StreamMessageMetadata = {
  usage?: LanguageModelUsage
  contextUsage?: Record<string, number>
  detailedContextUsage?: Record<string, unknown>
  codexAccount?: Record<string, unknown>
  codexRateLimits?: Record<string, unknown>
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
