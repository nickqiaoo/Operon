import { useEffect } from 'react'
import type { ExternalAgentFrame } from '@shared/external-agent'
import { subscribeEvents } from '@/lib/event-stream'
import { useExternalAgentsStore } from '@/stores/external-agents-store'
import { ensureWorkspaceKnown } from '@/lib/workspace-nav'

/**
 * One app-level subscription. A chat tab observes work; it never launches it.
 *
 * A new agent does not get a tab of its own: ten of them would bury the tabs the
 * user opened. Its parent's Agents card (Session panel) and its card in the
 * thread open it on demand (`openChildChat`).
 */
export function ExternalAgentsSync() {
  useEffect(() => {
    const subscription = subscribeEvents<ExternalAgentFrame>('external-agents', {
      onEvent: (frame) => {
        if (frame.type === 'sync') {
          useExternalAgentsStore.getState().sync(frame.agents)
          for (const agent of frame.agents) if (agent.workspaceId != null) void ensureWorkspaceKnown(agent.workspaceId)
          return
        }
        useExternalAgentsStore.getState().upsert(frame.agent)
        // One started in a workspace just made for it: bring that into the sidebar.
        if (frame.agent.workspaceId != null) void ensureWorkspaceKnown(frame.agent.workspaceId)
      },
    })
    return () => subscription.close()
  }, [])
  return null
}
