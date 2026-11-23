import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  ProjectStorageAdapter,
} from '../../storage/interface.js'
import { planChannelRewake, wakeUpBindingForRecovery } from './agent-orchestrator.js'
import { streamOfBinding, unreadIn } from './session-stream.js'

type Storage = ChannelStorageAdapter & ProjectStorageAdapter & AgentBindingStorageAdapter

/**
 * On app startup: reset all non-offline app and task bindings to idle — no
 * session survives a restart, so 'active' is stale.
 * Bindings are NOT auto-woken — users can wake them manually or recoverAgentSessions resumes those with unread.
 * An interrupted task picks up again when someone comments on it (the comment wakes its agent).
 */
export function resetAgentSessionsOnStartup(storage: Storage): void {
  const bindings = [
    ...storage.listBindings({ scopeKind: 'app' }),
    ...storage.listBindings({ scopeKind: 'thread' }),
    ...storage.listBindings({ scopeKind: 'task' }),
  ]
  for (const binding of bindings) {
    if (binding.status === 'offline') continue
    storage.updateBinding(binding.id, { status: 'idle' })
  }
}

/**
 * On app startup: scan all channel and thread sessions for ones with unread
 * messages and resume them with a recovery prompt.
 *
 * Uses at-most-once delivery — if the app crashed after advancing the cursor
 * but before processing, those messages are considered delivered. Agents
 * recover via MEMORY.md + check_messages on their own initiative.
 */
export async function recoverAgentSessions(storage: Storage): Promise<void> {
  const bindings = [...storage.listBindings({ scopeKind: 'app' }), ...storage.listBindings({ scopeKind: 'thread' })]

  for (const binding of bindings) {
    // Only recover bindings that were previously online
    if (binding.status === 'offline') continue

    const stream = streamOfBinding(storage, binding)
    if (!stream) continue
    const channelId = stream.channelId
    const channel = storage.getChannel(channelId)
    if (!channel) continue

    let needsRecovery = false

    // Unread messages that warrant a turn? (Same rule as turn end, so agent-only
    // chatter past the follow-up limit doesn't wake it after a restart either.)
    const unread = unreadIn(storage, binding.agentId, stream)
    if (unread.length > 0 && planChannelRewake(binding)) needsRecovery = true

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
