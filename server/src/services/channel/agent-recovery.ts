import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  ProjectStorageAdapter,
} from '../../storage/interface.js'
import { wakeUpBindingForRecovery } from './agent-orchestrator.js'

type Storage = ChannelStorageAdapter & ProjectStorageAdapter & AgentBindingStorageAdapter

/**
 * On app startup: reset all non-offline app bindings to idle.
 * Bindings are NOT auto-woken — users can wake them manually or recoverAgentSessions resumes those with unread.
 */
export function resetAgentSessionsOnStartup(storage: Storage): void {
  const bindings = storage.listBindings({ scopeKind: 'app' })
  for (const binding of bindings) {
    if (binding.status === 'offline') continue
    storage.updateBinding(binding.id, { status: 'idle' })
  }
}

/**
 * On app startup: scan all app bindings for ones with unread messages and
 * resume them with a recovery prompt.
 *
 * Uses at-most-once delivery — if the app crashed after advancing the cursor
 * but before processing, those messages are considered delivered. Agents
 * recover via MEMORY.md + check_messages on their own initiative.
 */
export async function recoverAgentSessions(storage: Storage): Promise<void> {
  const bindings = storage.listBindings({ scopeKind: 'app' })

  for (const binding of bindings) {
    // Only recover bindings that were previously online
    if (binding.status === 'offline') continue

    const channelId = Number(binding.scopeKey)
    if (!Number.isFinite(channelId)) continue
    const channel = storage.getChannel(channelId)
    if (!channel) continue

    let needsRecovery = false

    // Unread messages?
    const unread = storage.getUnreadChannelMessages(binding.agentId, channelId)
    if (unread.length > 0) needsRecovery = true

    if (needsRecovery) {
      try {
        await wakeUpBindingForRecovery(binding.id)
      } catch (err) {
        console.error(
          `[Recovery] Failed to resume binding ${binding.id} (agent=${binding.agentId} channel=${channelId}):`,
          err,
        )
      }
    } else {
      // Reset to idle — the previous 'active' status is stale after restart
      storage.updateBinding(binding.id, { status: 'idle' })
    }
  }
}
