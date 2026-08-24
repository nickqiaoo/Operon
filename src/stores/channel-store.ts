import { create } from 'zustand'
import { api } from '@/lib/api'
import type { Agent, AgentSessionStatus, Channel, ChannelMember, ChannelMessage, AgentSession, CreateAgentInput } from '@/types/channel'

interface ChannelStore {
  agents: Agent[]
  channels: Channel[]
  activeChannelId: number | null
  threadRootId: number | null
  threadRoots: ChannelMessage[]               // messages with replyCount > 0
  members: Record<number, ChannelMember[]>   // channelId -> members
  sessions: AgentSession[]                    // for current project

  loadAgents: () => Promise<void>
  loadChannels: (projectId: number) => Promise<void>
  loadMembers: (channelId: number) => Promise<void>
  loadSessions: (projectId: number) => Promise<void>

  createChannel: (projectId: number, name: string, description?: string) => Promise<Channel>
  deleteChannel: (id: number) => Promise<void>
  createAgent: (input: CreateAgentInput) => Promise<Agent>
  updateAgent: (id: number, updates: Partial<Agent>) => Promise<void>
  deleteAgent: (id: number) => Promise<void>
  addMember: (channelId: number, agentId: number) => Promise<void>
  removeMember: (channelId: number, agentId: number) => Promise<void>
  setThreadRoots: (threads: ChannelMessage[]) => void

  updateSessionStatus: (agentId: number, status: AgentSessionStatus) => void

  setActiveChannel: (id: number | null) => void
  setThreadRootId: (id: number | null) => void
}

export const useChannelStore = create<ChannelStore>((set, get) => ({
  agents: [],
  channels: [],
  activeChannelId: null,
  threadRootId: null,
  threadRoots: [],
  members: {},
  sessions: [],

  loadAgents: async () => {
    const { agents } = await api.agentList()
    set({ agents })
  },

  loadChannels: async (projectId) => {
    const { channels } = await api.channelList(projectId)
    set({ channels })
  },

  loadMembers: async (channelId) => {
    const { members } = await api.channelMemberList(channelId)
    set((s) => ({ members: { ...s.members, [channelId]: members } }))
  },

  loadSessions: async (projectId) => {
    const { sessions } = await api.channelAgentSessions(projectId)
    set({ sessions })
  },

  createChannel: async (projectId, name, description) => {
    const { channel } = await api.channelCreate({ projectId, name, description })
    set((s) => ({ channels: [...s.channels, channel] }))
    return channel
  },

  deleteChannel: async (id) => {
    await api.channelDelete(id)
    set((s) => ({
      channels: s.channels.filter((c) => c.id !== id),
      activeChannelId: s.activeChannelId === id ? null : s.activeChannelId,
    }))
  },

  createAgent: async (input) => {
    const { agent } = await api.agentCreate(input)
    set((s) => ({ agents: [...s.agents, agent] }))
    return agent
  },

  updateAgent: async (id, updates) => {
    const { agent } = await api.agentUpdate(id, updates)
    set((s) => ({ agents: s.agents.map((a) => (a.id === id ? agent : a)) }))
  },

  deleteAgent: async (id) => {
    await api.agentDelete(id)
    set((s) => ({ agents: s.agents.filter((a) => a.id !== id) }))
  },

  addMember: async (channelId, agentId) => {
    await api.channelMemberAdd(channelId, agentId)
    await get().loadMembers(channelId)
  },

  removeMember: async (channelId, agentId) => {
    await api.channelMemberRemove(channelId, agentId)
    set((s) => ({
      members: {
        ...s.members,
        [channelId]: (s.members[channelId] ?? []).filter((m) => m.agentId !== agentId),
      },
    }))
  },

  setThreadRoots: (threads) => {
    const prev = get().threadRoots
    // Shallow compare: skip update if same ids and replyCounts
    if (
      prev.length === threads.length &&
      prev.every((p, i) => p.id === threads[i].id && p.replyCount === threads[i].replyCount)
    ) return
    set({ threadRoots: threads })
  },

  updateSessionStatus: (agentId, status) => {
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.agentId === agentId ? { ...session, status } : session
      ),
    }))
  },

  setActiveChannel: (id) => set({ activeChannelId: id, threadRootId: null, threadRoots: id === null ? [] : get().threadRoots }),
  setThreadRootId: (id) => set({ threadRootId: id }),
}))
