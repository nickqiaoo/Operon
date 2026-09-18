/**
 * Account-scoped Codex rate limits, independent of any conversation.
 *
 * The mirror of `providers/claude/usage-probe.ts`, and it exists for the same
 * reason: the quota belongs to the signed-in account, so the UI wants it
 * whether or not a Codex chat happens to be open.
 *
 * Where Claude needs a dedicated process, Codex does not. `account/rateLimits/read`
 * is a plain request on the thread-multiplexed app-server, so this reuses a
 * connection some conversation already opened and only starts its own when
 * nothing is connected.
 */

import { getRuntimeHost } from '../../host.js'
import { createRuntimeLogger } from '../../logger.js'
import {
  acquireAppServerClient,
  peekAnyAppServerClient,
  type AppServerLease,
} from './sdk/client-registry.js'
import type { AccountRateLimitsReadResult } from './sdk/protocol/index.js'

const logger = createRuntimeLogger('codex-usage')

/**
 * Held for the lifetime of the app once taken, rather than acquired and
 * released per read: releasing the last lease disposes the server, so a
 * per-read lease would spawn and kill a process on every poll.
 */
let probeLease: AppServerLease | null = null

/**
 * Reuse whatever a conversation already has open; fall back to a connection of
 * our own. The env is deliberately left empty — it takes part in the registry's
 * connection key, and a probe that guessed at one would key to its own entry
 * and start a second server beside the one already running.
 */
function resolveClient(): ReturnType<typeof peekAnyAppServerClient> {
  const shared = peekAnyAppServerClient()
  if (shared) return shared

  if (!probeLease) {
    const codexPath = getRuntimeHost().resolveCliPath('codex')
    if (!codexPath) {
      logger.info('Codex CLI not available, skipping usage probe')
      return undefined
    }
    probeLease = acquireAppServerClient({ codexPath })
    logger.info('Usage probe connection opened')
  }

  return probeLease.client
}

/**
 * Every rate-limit bucket on the account, or null when Codex cannot answer
 * (no CLI, signed out, or the read failed — the caller shows nothing either way).
 *
 * `maxAgeMs` is how stale a cached read may be. The default suits polling; a
 * manual refresh passes 0, because a user who presses the button has just been
 * told a number they do not believe, and serving them the cached copy of that
 * same number is the one answer the press cannot mean.
 */
export async function getCodexAccountUsage(
  maxAgeMs?: number,
): Promise<AccountRateLimitsReadResult | null> {
  const client = resolveClient()
  if (!client) return null

  try {
    return await client.readRateLimits(maxAgeMs)
  } catch (error) {
    logger.info(`usage read failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** Release the probe's own connection, if it ever took one (app shutdown). */
export function disposeCodexUsageProbe(): void {
  const lease = probeLease
  probeLease = null
  lease?.release()
}
