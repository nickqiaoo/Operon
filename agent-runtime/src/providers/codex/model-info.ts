import type { Model, ProviderDescriptor } from '../../types.js'
import type { ModelInfo } from './sdk/protocol/messages.js'

export const getModelDisplayName = (model: ModelInfo): string => {
  const displayName = model.displayName?.trim() ?? ''
  if (displayName.length > 0) return displayName
  const fallback = model.model?.trim() ?? ''
  return fallback.length > 0 ? fallback : model.id
}

const getSupportedEffortLevels = (model: ModelInfo): NonNullable<Model['supportedEffortLevels']> =>
  (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort)

const formatReasoningEffortName = (effort: string): string =>
  effort
    .replace(/^x(?=high$)/i, 'extra-')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())

export const mapModelInfoToDescriptor = (model: ModelInfo): Model => ({
  id: model.id,
  name: getModelDisplayName(model),
  description: model.description,
  supportedEffortLevels: getSupportedEffortLevels(model),
})

export const buildThinkingLevelsFromModelInfo = (
  models: ModelInfo[],
): NonNullable<ProviderDescriptor['thinkingLevels']> => {
  const levels = new Map<string, NonNullable<ProviderDescriptor['thinkingLevels']>[number]>()

  for (const model of models) {
    for (const option of model.supportedReasoningEfforts ?? []) {
      const effort = option.reasoningEffort
      if (!levels.has(effort)) {
        levels.set(effort, { id: effort, name: formatReasoningEffortName(effort) })
      }
    }
  }

  return [...levels.values()]
}

export const getDefaultThinkingLevelFromModelInfo = (
  defaultModel: ModelInfo | undefined,
  models: ModelInfo[],
): string | undefined => {
  const defaultEffort = defaultModel?.defaultReasoningEffort
  if (
    defaultEffort &&
    (defaultModel.supportedReasoningEfforts ?? []).some((option) => option.reasoningEffort === defaultEffort)
  ) {
    return defaultEffort
  }

  return defaultModel?.supportedReasoningEfforts?.[0]?.reasoningEffort
    ?? models.find((model) => (model.supportedReasoningEfforts ?? []).length > 0)
      ?.supportedReasoningEfforts?.[0]
      ?.reasoningEffort
}
