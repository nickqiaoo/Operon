import type { Agent } from '../types/channel.js'
import type { AgentBindingStorageAdapter, ChannelStorageAdapter, ProjectStorageAdapter } from '../storage/interface.js'

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

export type WorkspaceChatContextStorage = Pick<ChannelStorageAdapter, 'getAgentByName' | 'createAgent'> &
  Pick<ProjectStorageAdapter, 'getWorkspace'> & Pick<AgentBindingStorageAdapter, 'getBindingByActiveChatId'>

/** Resolve the actor for a user chat on both its first turn and a cold restore. */
export function workspaceChatAgentContext(storage: WorkspaceChatContextStorage, chat: {
  chatId?: number; workspaceId?: number; providerId?: string; modelId?: string
}) {
  const binding = chat.chatId != null ? storage.getBindingByActiveChatId(chat.chatId) : null
  if (binding?.scopeKind === 'task' && binding.projectId != null) {
    return { agentId: binding.agentId, projectId: binding.projectId }
  }
  const workspace = chat.workspaceId ? storage.getWorkspace(chat.workspaceId) : undefined
  if (!workspace) return undefined
  const assistant = getOrCreateWorkspaceAssistant(storage, { provider: chat.providerId, model: chat.modelId })
  return { agentId: assistant.id, projectId: workspace.projectId }
}
