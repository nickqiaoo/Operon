import { useEffect } from 'react'
import type { ExternalAgentFrame } from '@shared/external-agent'
import { api } from '@/lib/api'
import { subscribeSse } from '@/lib/sse'
import { useEditorStore } from '@/stores/editor-store'
import { useExternalAgentsStore } from '@/stores/external-agents-store'

/** One app-level subscription. A chat tab observes work; it never launches it. */
export function ExternalAgentsSync() {
  useEffect(() => {
    const subscription = subscribeSse<ExternalAgentFrame>({
      url: () => api.externalAgentFeedUrl(),
      onEvent: (frame) => {
        if (frame.type === 'sync') {
          useExternalAgentsStore.getState().sync(frame.agents)
          return
        }
        useExternalAgentsStore.getState().upsert(frame.agent)
        if (frame.type === 'created') {
          const agent = frame.agent
          useEditorStore.getState().openChatTab(`chat:${agent.childChatId}`, `Agent: ${agent.description}`,
            { background: true, modelId: agent.modelId ?? 'default', modeId: agent.modeId }, agent.providerId, true)
        }
      },
    })
    return () => subscription.close()
  }, [])
  return null
}
