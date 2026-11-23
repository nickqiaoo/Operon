import { useMemo } from 'react'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { ChannelThread, WaitingSession } from '@/types/channel'
import { api } from './api'

/**
 * TanStack Query layer for channel threads: each thread's owner, the status and
 * summary it last reported, and which agents are running in it right now.
 *
 * The list is read once per channel; after that the channel's SSE stream keeps
 * it current (`thread_updated` → `applyThreadUpdate`), so it never polls.
 */
export const channelKeys = {
  all: ['channel'] as const,
  threads: (channelId: number) => ['channel', channelId, 'threads'] as const,
  /** The channel sessions (not threads) waiting on a person — kept current by `sessions_waiting`. */
  waiting: (channelId: number) => ['channel', channelId, 'waiting'] as const,
}

export function useChannelWaitingSessions(channelId: number | null) {
  return useQuery({
    queryKey: channelKeys.waiting(channelId ?? 0),
    queryFn: async () => (await api.channelWaitingSessions(channelId!)).waiting,
    enabled: channelId != null && channelId > 0,
    staleTime: Infinity,
  })
}

export function applyWaitingSessions(queryClient: QueryClient, channelId: number, waiting: WaitingSession[]): void {
  queryClient.setQueryData<WaitingSession[]>(channelKeys.waiting(channelId), waiting)
}

export function useChannelThreads(channelId: number | null) {
  return useQuery({
    queryKey: channelKeys.threads(channelId ?? 0),
    queryFn: async () => (await api.channelThreadList(channelId!)).threads.map(normalizeThread),
    enabled: channelId != null && channelId > 0,
    staleTime: Infinity,
  })
}

/** The channel's threads keyed by root message id. */
export function useChannelThreadMap(channelId: number | null): Map<number, ChannelThread> {
  const { data } = useChannelThreads(channelId)
  return useMemo(() => new Map((data ?? []).map((t) => [t.rootMessageId, t])), [data])
}

/** Fold a `thread_updated` event into the cached list (newest activity first). */
export function applyThreadUpdate(queryClient: QueryClient, incoming: ChannelThread): void {
  const thread = normalizeThread(incoming)
  queryClient.setQueryData<ChannelThread[]>(channelKeys.threads(thread.channelId), (prev) => {
    if (!prev) return prev
    const rest = prev.filter((t) => t.rootMessageId !== thread.rootMessageId)
    return [thread, ...rest].sort((a, b) => b.updatedAt - a.updatedAt)
  })
}

/**
 * The web app can be newer than the desktop server it talks to, so a field
 * added since may be missing from what arrives: absent lists read as empty
 * instead of crashing the channel view.
 */
function normalizeThread(t: ChannelThread): ChannelThread {
  return {
    ...t,
    participantAgentIds: t.participantAgentIds ?? [],
    activeAgentIds: t.activeAgentIds ?? [],
    waiting: t.waiting ?? [],
  }
}
