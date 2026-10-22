import type * as acp from '@agentclientprotocol/sdk'
import type { ThinkingLevel } from '../../types.js'

type SelectOption = Extract<acp.SessionConfigOption, { type: 'select' }>

export function findConfigOption(
  options: readonly acp.SessionConfigOption[],
  category: string,
): SelectOption | undefined {
  return options.find((option): option is SelectOption => option.type === 'select' && option.category === category)
}

export function configValues(option: SelectOption): acp.SessionConfigSelectOption[] {
  return option.options.flatMap((entry) => 'options' in entry ? entry.options : [entry])
}

export function thinkingConfig(options: readonly acp.SessionConfigOption[]): {
  thinkingLevels: ThinkingLevel[]
  currentThinkingLevel: string | undefined
} {
  const option = findConfigOption(options, 'thought_level')
  return {
    thinkingLevels: option ? configValues(option).map(({ value, name }) => ({ id: value, name })) : [],
    currentThinkingLevel: option?.currentValue,
  }
}
