import fs from 'node:fs'
import { getOperonHome } from '../../../../shared/operon-home.js'
import path from 'node:path'

/**
 * Which conversation the background extractor is reading right now.
 *
 * The source of a memory write cannot travel with the extractor's session:
 * OpenCode registers MCP servers per directory (one connection for every
 * session there) and ACP reuses connections by cwd, so a per-session value in
 * the server URL sticks to whichever session registered first. Instead the
 * extractor's sessions all carry the same static marker (`?origin=maintenance`)
 * and the memory MCP route asks here which conversation that is. Runs are
 * serialized (see runner.ts) and chunks run one at a time, so there is exactly
 * one answer at any moment.
 */
let currentSource: string | null = null

export function setExtractionSource(source: string | null): void {
  currentSource = source
}

export function getExtractionSource(): string | null {
  return currentSource
}

/** Query marker on the extractor's memory MCP URL. */
export const MAINTENANCE_ORIGIN = 'maintenance'

/**
 * The extractor's own working directory. Sessions there must not share
 * provider-side state with real chats: with the server's cwd (the repository
 * itself in development) an OpenCode / ACP chat in that folder could reuse the
 * extractor's MCP connection, or the other way round, and the provider would
 * also load the repository's agent instructions into the extractor.
 */
export function maintenanceWorkdir(): string {
  const dir = path.join(getOperonHome(), 'memory-maintenance')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
