import type { ProviderConfig } from './types'

export const opencodeProvider: ProviderConfig = {
  id: 'opencode',
  label: 'OpenCode',
  logo: 'opencode',
  command: 'opencode',
  args: ['acp'],
  models: [
    { id: 'opencode', label: 'OpenCode' },
  ],
  getArgs() {
    return ['acp']
  },
}
