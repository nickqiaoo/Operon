import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'

const marker = '_OPERON_SHELL_ENV_'
const command = `printf '${marker}\\0'; /usr/bin/env -0 && printf '${marker}\\0'`
// The first read has nothing to fall back to: a slow shell profile (nvm, conda) must still land,
// or tools installed through it are missing until the next refresh. Later refreshes keep the
// last snapshot meanwhile, so they can give up sooner.
const firstBudgetMs = 10_000
const refreshBudgetMs = 2_000
const refreshIntervalMs = 30_000
let snapshot: Record<string, string> = {}
let loaded = false
let nextRefresh = 0
let pending: Promise<void> | undefined

function probe(shell: string, remaining: number): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = execFile(shell, ['-ilc', command], {
      encoding: 'utf8',
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true', ZSH_TMUX_AUTOSTART: 'false' },
    }, (error, stdout) => {
      clearTimeout(timer)
      const [, block, end] = stdout.split(marker + '\0')
      if (error || !block || end === undefined) {
        reject(error ?? new Error('Incomplete login shell environment'))
        return
      }
      const entries = block.split('\0').filter(entry => entry.includes('='))
      resolve(Object.fromEntries(entries.map(entry => {
        const at = entry.indexOf('=')
        return [entry.slice(0, at), entry.slice(at + 1)]
      })))
    })
    child.stdin?.end()
    // Descendants may retain the pipes even after the login shell exits.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      child.stdout?.destroy()
      child.stderr?.destroy()
      reject(new Error('Login shell timed out'))
    }, remaining)
  })
}

async function refresh(): Promise<void> {
  if (process.platform === 'win32') {
    snapshot = Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined))
    return
  }
  let shell = process.env.SHELL
  try { shell = userInfo().shell || shell } catch { /* Use the inherited shell. */ }
  const deadline = Date.now() + (loaded ? refreshBudgetMs : firstBudgetMs)
  for (const candidate of new Set([shell, '/bin/zsh', '/bin/bash'])) {
    const remaining = deadline - Date.now()
    if (!candidate || remaining <= 0) continue
    try {
      snapshot = await probe(candidate, remaining)
      loaded = true
      return
    } catch { /* Keep the last successful snapshot if every shell fails. */ }
  }
}

export function refreshLoginShellEnv(): Promise<void> {
  if (pending) return pending
  if (Date.now() < nextRefresh) return Promise.resolve()
  pending = refresh().finally(() => {
    nextRefresh = Date.now() + refreshIntervalMs
    pending = undefined
  })
  return pending
}

export function getShellEnv(): Record<string, string> {
  void refreshLoginShellEnv()
  return snapshot
}
