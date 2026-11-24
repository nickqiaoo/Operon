import { create } from 'zustand'
import type { ExternalAgentView } from '@shared/external-agent'
import { LOCAL_NODE, nodeIdOf, type NodeKey } from '@/lib/chat-ref'

/**
 * An agent as one machine's `external-agents` feed reported it. `nodeId` says
 * which machine (absent for this one): its `parentChatId` / `childChatId` are
 * chat ids on that machine.
 */
export type TrackedExternalAgent = ExternalAgentView & { nodeId?: string }

/** Store key: the agent id for this machine's agents, `<nodeId>:<agentId>` for another's. */
export function externalAgentKey(nodeId: string | undefined, agentId: string): string {
  return nodeId ? `${nodeId}:${agentId}` : agentId
}

const track = (node: NodeKey, agent: ExternalAgentView): TrackedExternalAgent => {
  const nodeId = nodeIdOf(node)
  return nodeId ? { ...agent, nodeId } : agent
}

export const useExternalAgentsStore = create<{
  agents: ReadonlyMap<string, TrackedExternalAgent>
  /** One machine's full list (its feed's `sync` frame); other machines' entries are kept. */
  sync: (node: NodeKey, agents: ExternalAgentView[]) => void
  upsert: (node: NodeKey, agent: ExternalAgentView) => void
  /** Forget every machine's agents (the backend node was switched). */
  reset: () => void
}>((set) => ({
  agents: new Map(),
  reset: () => set({ agents: new Map() }),
  sync: (node, agents) =>
    set((state) => {
      const next = new Map<string, TrackedExternalAgent>()
      for (const [key, agent] of state.agents) if ((agent.nodeId ?? LOCAL_NODE) !== node) next.set(key, agent)
      for (const agent of agents) next.set(externalAgentKey(nodeIdOf(node), agent.agentId), track(node, agent))
      return { agents: next }
    }),
  upsert: (node, agent) =>
    set((state) => ({
      agents: new Map(state.agents).set(externalAgentKey(nodeIdOf(node), agent.agentId), track(node, agent)),
    })),
}))

/** Whether an agent was reported by the machine `nodeId` names (undefined: this one). */
export function isOnNode(agent: TrackedExternalAgent, nodeId: string | undefined): boolean {
  return (agent.nodeId ?? undefined) === (nodeId ?? undefined)
}
