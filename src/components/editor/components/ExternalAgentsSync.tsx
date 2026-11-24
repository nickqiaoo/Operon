import { useEffect } from 'react'
import type { ExternalAgentFrame } from '@shared/external-agent'
import { subscribeEvents } from '@/lib/event-stream'
import { useExternalAgentsStore } from '@/stores/external-agents-store'
import { ensureWorkspaceKnown } from '@/lib/workspace-nav'
import { nodeKeyOf } from '@/lib/chat-ref'

/**
 * One app-level subscription. A chat tab observes work; it never launches it.
 *
 * A new agent does not get a tab of its own: ten of them would bury the tabs the
 * user opened. Its parent's Agents card (Session panel) and its card in the
 * thread open it on demand (`openChildChat`).
 *
 * `nodeId` set: another machine's agents, for the tabs showing its chats
 * (see `RemoteNodeFeeds`). Their workspaces are that machine's, so they are not
 * pulled into this machine's sidebar.
 */
export function ExternalAgentsSync({ nodeId }: { nodeId?: string } = {}) {
  useEffect(() => {
    const node = nodeKeyOf(nodeId)
    const subscription = subscribeEvents<ExternalAgentFrame>('external-agents', {
      onEvent: (frame) => {
        if (frame.type === 'sync') {
          useExternalAgentsStore.getState().sync(node, frame.agents)
          if (!nodeId) for (const agent of frame.agents) if (agent.workspaceId != null) void ensureWorkspaceKnown(agent.workspaceId)
          return
        }
        useExternalAgentsStore.getState().upsert(node, frame.agent)
        // One started in a workspace just made for it: bring that into the sidebar.
        if (!nodeId && frame.agent.workspaceId != null) void ensureWorkspaceKnown(frame.agent.workspaceId)
      },
    }, nodeId)
    return () => {
      subscription.close()
      // A remote machine's list is only kept while something shows its chats.
      if (nodeId) useExternalAgentsStore.getState().sync(node, [])
    }
  }, [nodeId])
  return null
}
