import type { LanguageModelUsage } from 'ai'
import type { RuntimeGoal, RuntimeUsageLimits, StreamMessageMetadata } from '@operon/agent-runtime'

/**
 * Message metadata as the client reads it — flat, with each provider's extras
 * under its own key name. It is also what assistant messages already stored in
 * the database carry, so it stays this shape; the runtime's namespaced form is
 * translated here, at the one place a turn's parts become UI chunks.
 */
export type UiMessageMetadata = {
  usage?: LanguageModelUsage
  contextUsage?: Record<string, number>
  compacted?: Record<string, unknown>
  contextCompaction?: StreamMessageMetadata['contextCompaction']
  codexAccount?: Record<string, unknown>
  codexRateLimits?: Record<string, unknown>
  claudeRateLimits?: RuntimeUsageLimits
  /** The thread goal, from any provider with `features.goal` (named for the one that had it first). */
  codexGoal?: RuntimeGoal
}

export function toUiMessageMetadata(metadata: StreamMessageMetadata & Record<string, unknown>): UiMessageMetadata {
  const { goal, codex, 'claude-code': claudeCode, ...common } = metadata
  return {
    ...common,
    ...(goal ? { codexGoal: goal } : {}),
    ...(codex?.account ? { codexAccount: codex.account } : {}),
    ...(codex?.rateLimits ? { codexRateLimits: codex.rateLimits } : {}),
    ...(claudeCode?.rateLimits ? { claudeRateLimits: claudeCode.rateLimits } : {}),
  }
}
