import type { ProviderConfig } from './types'

export const geminiProvider: ProviderConfig = {
  id: 'gemini',
  label: 'Gemini CLI',
  logo: 'google',
  command: 'gemini',
  args: [],
  models: [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  getArgs() {
    return []
  },
}
