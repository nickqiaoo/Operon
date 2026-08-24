import type { ProviderConfig } from './types'

export const claudeCodeProvider: ProviderConfig = {
  id: 'claude-code',
  label: 'Claude Code',
  logo: 'anthropic',
  command: 'claude-code-acp',
  args: [],
  models: [
    { id: 'default', label: 'Default' },
    { id: 'best', label: 'Best' },
    { id: 'fable', label: 'Fable' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
    { id: 'sonnet[1m]', label: 'Sonnet 1M' },
    { id: 'opus[1m]', label: 'Opus 1M' },
    { id: 'opusplan', label: 'Opus Plan' },
  ],
  defaultModel: 'default',
  supportsSetModel: true,
  getArgs() {
    return []
  },
}
