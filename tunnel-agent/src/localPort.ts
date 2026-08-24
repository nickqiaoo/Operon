import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface ServerInfo {
  port: number
  url?: string
  pid?: number
  updatedAt?: string
}

/**
 * Resolve the local operon backend base URL (no trailing slash, no /api).
 *
 * Order:
 *  1. `LOCAL_BASE` env override (headless deploys / tests),
 *  2. `~/.operon/plugin-server.json` published by server/src/start.ts.
 *
 * The broker forwards paths that already start with `/api`, so the base must be the
 * bare origin (e.g. http://127.0.0.1:3100).
 */
/**
 * Resolve the local backend's startup api token for a STANDALONE agent.
 *
 * Order: `OPERON_API_TOKEN` env override, then the token file the server
 * publishes at `~/.operon/run/api-token`. Returns undefined when neither
 * exists (e.g. the backend runs with auth disabled) — forwarding then simply
 * omits the header. The embedded (in-process) agent never calls this; it gets
 * the token passed directly via AgentOptions.localToken.
 */
export async function resolveLocalToken(): Promise<string | undefined> {
  const override = process.env.OPERON_API_TOKEN
  if (override) return override
  try {
    const raw = await readFile(join(homedir(), '.operon', 'run', 'api-token'), 'utf-8')
    const token = raw.trim()
    return token || undefined
  } catch {
    return undefined
  }
}

export async function resolveLocalBase(): Promise<string> {
  const override = process.env.LOCAL_BASE
  if (override) return override.replace(/\/$/, '')

  const file = join(homedir(), '.operon', 'plugin-server.json')
  const raw = await readFile(file, 'utf-8')
  const info = JSON.parse(raw) as ServerInfo
  const base = info.url ?? `http://127.0.0.1:${info.port}`
  return base.replace(/\/$/, '')
}
