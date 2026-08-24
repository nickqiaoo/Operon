import type { ProviderConfig } from './types'
import { geminiProvider } from './gemini'
import { codexProvider } from './codex'
import { claudeCodeProvider } from './claude-code'
import { opencodeProvider } from './opencode'

export type { ProviderConfig, ProviderModelInfo } from './types'

export const providers: Record<string, ProviderConfig> = {
  gemini: geminiProvider,
  codex: codexProvider,
  'claude-code': claudeCodeProvider,
  opencode: opencodeProvider,
}

export const providerList = Object.values(providers)

/**
 * Parse a model selector ID into provider + model.
 * Format: "providerId" or "providerId:modelId"
 * Examples: "gemini" -> { provider: geminiProvider, modelId: undefined }
 *           "codex:gpt-5.2-codex" -> { provider: codexProvider, modelId: "gpt-5.2-codex" }
 */
export function resolveProvider(selectorId: string): { provider: ProviderConfig; modelId?: string } | null {
  const colonIdx = selectorId.indexOf(':')
  let providerId: string
  let modelId: string | undefined

  if (colonIdx === -1) {
    providerId = selectorId
  } else {
    providerId = selectorId.slice(0, colonIdx)
    modelId = selectorId.slice(colonIdx + 1)
  }

  const provider = providers[providerId]
  if (!provider) return null

  return { provider, modelId }
}
