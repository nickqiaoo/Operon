import { delimiter } from 'node:path'
import { getRuntimeHost } from './host.js'

function filterEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  if (!env) return {}

  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.trim()) continue
    if (typeof value !== 'string') continue
    result[key] = value
  }
  return result
}

/**
 * Merge PATH from multiple env sources, preserving order and deduplicating.
 * Later sources' directories are prepended so they take precedence.
 */
function mergePaths(...envs: Record<string, string>[]): string {
  const seen = new Set<string>()
  const dirs: string[] = []
  // Iterate in reverse so later (higher-priority) sources come first
  for (let i = envs.length - 1; i >= 0; i--) {
    const pathValue = envs[i].PATH
    if (!pathValue) continue
    for (const dir of pathValue.split(delimiter)) {
      if (dir && !seen.has(dir)) {
        seen.add(dir)
        dirs.push(dir)
      }
    }
  }
  return dirs.join(delimiter)
}

export function buildRuntimeEnv(
  sessionEnv?: Record<string, string | undefined>,
): Record<string, string> {
  const host = getRuntimeHost()
  const shellEnv = host.getShellEnv()
  const processEnv = filterEnv(process.env)
  const userEnv = host.getUserEnv()
  const sesEnv = filterEnv(sessionEnv)

  const merged = {
    ...shellEnv,
    ...processEnv,
    ...userEnv,
    ...sesEnv,
  }

  // Merge PATH from all sources instead of letting later sources overwrite
  const mergedPath = mergePaths(shellEnv, processEnv, userEnv, sesEnv)
  if (mergedPath) {
    merged.PATH = mergedPath
  }

  return merged
}

export function applyRuntimeEnv(
  sessionEnv?: Record<string, string | undefined>,
): void {
  const merged = buildRuntimeEnv(sessionEnv)
  for (const [key, value] of Object.entries(merged)) {
    process.env[key] = value
  }
}
