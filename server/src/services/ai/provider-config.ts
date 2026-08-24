import type { ProviderDescriptor, ProviderAccountInfo } from '@operon/agent-runtime'

type ProviderConfigCategory = 'model' | 'mode' | 'thought_level' | 'service_tier'

interface ProviderConfigOptionItem {
  value: string
  name: string
  description?: string
  providerId?: string
  providerLabel?: string
  providerLogo?: string
  // Per-model capabilities (only populated for the 'model' category).
  supportedEffortLevels?: string[]
  supportsAutoMode?: boolean
  supportsFastMode?: boolean
  supportsAdaptiveThinking?: boolean
}

interface ProviderConfigOption {
  category: ProviderConfigCategory
  currentValue?: string
  options: ProviderConfigOptionItem[]
}

export interface ProviderModelsResult {
  models: Array<{ modelId: string; name: string; description?: string; providerId?: string }>
  modelsPending?: boolean
  currentModelId: string
  modes: Array<{ id: string; name: string; description?: string }>
  currentModeId: string
  serviceTiers: Array<{ id: string; name: string; description?: string }>
  currentServiceTier?: string
  commands: Array<{ id: string; name: string; description?: string }>
  skills: ProviderDescriptor['skills']
  slashCommands: ProviderDescriptor['slashCommands']
  features: ProviderDescriptor['features']
  account?: ProviderAccountInfo
  configOptions: ProviderConfigOption[]
  fetchedAt: number
}

const createEmptyProviderModelsResult = (): ProviderModelsResult => ({
  models: [],
  modes: [],
  currentModelId: '',
  currentModeId: '',
  serviceTiers: [],
  commands: [],
  skills: [],
  slashCommands: [],
  features: {
    permissions: false,
    attachments: false,
    injection: false,
    sessionResume: false,
  },
  configOptions: [],
  fetchedAt: Date.now(),
})

export const buildProviderModelsResult = (
  descriptor: ProviderDescriptor | undefined
): ProviderModelsResult => {
  if (!descriptor) {
    return createEmptyProviderModelsResult()
  }

  const configOptions: ProviderConfigOption[] = []

  if (descriptor.models.length > 0) {
    configOptions.push({
      category: 'model',
      currentValue: descriptor.currentModelId,
      options: descriptor.models.map((model) => ({
        value: model.id,
        name: model.name,
        description: model.description ?? '',
        providerId: model.providerId,
        providerLabel: model.providerLabel,
        providerLogo: model.providerLogo,
        supportedEffortLevels: model.supportedEffortLevels,
        supportsAutoMode: model.supportsAutoMode,
        supportsFastMode: model.supportsFastMode,
        supportsAdaptiveThinking: model.supportsAdaptiveThinking,
      })),
    })
  }

  if (descriptor.modes.length > 0) {
    configOptions.push({
      category: 'mode',
      currentValue: descriptor.currentModeId,
      options: descriptor.modes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? '',
      })),
    })
  }

  if (descriptor.thinkingLevels && descriptor.thinkingLevels.length > 0) {
    configOptions.push({
      category: 'thought_level',
      currentValue: descriptor.currentThinkingLevel,
      options: descriptor.thinkingLevels.map((level) => ({
        value: level.id,
        name: level.name,
      })),
    })
  }

  if (descriptor.serviceTiers && descriptor.serviceTiers.length > 0) {
    configOptions.push({
      category: 'service_tier',
      currentValue: descriptor.currentServiceTier,
      options: descriptor.serviceTiers.map((tier) => ({
        value: tier.id,
        name: tier.name,
        description: tier.description ?? '',
      })),
    })
  }

  return {
    models: descriptor.models.map((model) => ({
      modelId: model.id,
      name: model.name,
      description: model.description,
      providerId: model.providerId,
    })),
    modelsPending: descriptor.modelsPending,
    currentModelId: descriptor.currentModelId,
    modes: descriptor.modes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      description: mode.description,
    })),
    currentModeId: descriptor.currentModeId,
    serviceTiers: descriptor.serviceTiers?.map((tier) => ({
      id: tier.id,
      name: tier.name,
      description: tier.description,
    })) ?? [],
    currentServiceTier: descriptor.currentServiceTier,
    commands: descriptor.commands.map((command) => ({
      id: command.id,
      name: command.name,
      description: command.description,
    })),
    skills: descriptor.skills ?? [],
    slashCommands: descriptor.slashCommands ?? [],
    features: descriptor.features,
    account: descriptor.account,
    configOptions,
    fetchedAt: Date.now(),
  }
}
