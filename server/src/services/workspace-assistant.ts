import type { Agent } from '../types/channel.js'
import type { ChannelStorageAdapter } from '../storage/interface.js'

/** The name of the hidden agent a direct workspace chat speaks as on the task board. */
export const WORKSPACE_ASSISTANT_NAME = 'Workspace Assistant'

/**
 * The agent a direct workspace chat acts as. A workspace chat is user ↔ CLI with
 * no registered agent, but the task board records an agent on everything it does
 * (who started a spec, who commented). One hidden, reusable agent per install
 * fills that role; it never executes — dispatch always picks a real agent.
 * Hidden so it never appears in user-facing agent pickers.
 */
export function getOrCreateWorkspaceAssistant(
  storage: Pick<ChannelStorageAdapter, 'getAgentByName' | 'createAgent'>,
  fallback?: { provider?: string; model?: string },
): Agent {
  const existing = storage.getAgentByName(WORKSPACE_ASSISTANT_NAME)
  if (existing) return existing
  return storage.createAgent({
    name: WORKSPACE_ASSISTANT_NAME,
    provider: fallback?.provider ?? 'claude-code',
    model: fallback?.model ?? 'sonnet',
    instructions: '',
    hidden: true,
  })
}
