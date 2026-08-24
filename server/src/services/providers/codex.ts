import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { ProviderConfig } from './types'

function getCodexBinaryPath(): string {
  // Packaged Electron app: binary bundled in resources
  const rp = (process as any).resourcesPath as string | undefined
  if (rp && !rp.includes('node_modules')) {
    return join(rp, 'bin', 'codex-acp')
  }
  // Dev mode: try project-root/src/bin/codex-acp
  const localBin = resolve(process.cwd(), 'src', 'bin', 'codex-acp')
  if (existsSync(localBin)) {
    return localBin
  }
  // Fallback: expect codex-acp in PATH
  return 'codex-acp'
}

export const codexProvider: ProviderConfig = {
  id: 'codex',
  label: 'Codex',
  logo: 'openai',
  command: getCodexBinaryPath(),
  args: [],
  models: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  ],
  defaultModel: 'gpt-5.6-sol',
  supportsSetModel: true,
  getArgs() {
    return []
  },
}
