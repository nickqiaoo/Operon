import { create } from 'zustand'
import type { ExternalAgentView } from '@shared/external-agent'

export const useExternalAgentsStore = create<{
  agents: ReadonlyMap<string, ExternalAgentView>
  sync: (agents: ExternalAgentView[]) => void
  upsert: (agent: ExternalAgentView) => void
}>((set) => ({
  agents: new Map(),
  sync: (agents) => set({ agents: new Map(agents.map((agent) => [agent.agentId, agent])) }),
  upsert: (agent) => set((state) => ({ agents: new Map(state.agents).set(agent.agentId, agent) })),
}))
