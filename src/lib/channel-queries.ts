import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ChannelThread, ChannelUnread, WaitingSession } from '@/types/channel'
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
  /** The members whose channel session is running a turn — kept current by `sessions_working`. */
  working: (channelId: number) => ['channel', channelId, 'working'] as const,
}

const NO_AGENTS: number[] = []

/**
 * Agents running a turn in the channel itself (thread work shows on its thread).
 * An older desktop server has no such endpoint: read that as nobody working.
 */
export function useChannelWorkingAgents(channelId: number | null): number[] {
  const { data } = useQuery({
    queryKey: channelKeys.working(channelId ?? 0),
    queryFn: async () => (await api.channelWorkingAgents(channelId!).catch(() => ({ agentIds: NO_AGENTS }))).agentIds,
    enabled: channelId != null && channelId > 0,
    staleTime: Infinity,
  })
  return data ?? NO_AGENTS
}

export function applyWorkingAgents(queryClient: QueryClient, channelId: number, agentIds: number[]): void {
  queryClient.setQueryData<number[]>(channelKeys.working(channelId), agentIds)
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

// ---- The person's unread ----
//
// Read once (`GET /channels/unread`), then kept current by the inbox stream's
// `channel_unread` events (`applyChannelUnread`), which carry one channel's
// fresh counts — no refetch per message. The stream's snapshot on (re)connect
// refetches it (`useInboxStream`), which heals anything missed while it was down.

export const channelUnreadKey = ['channel', 'unread'] as const

const NO_UNREAD = new Map<number, ChannelUnread>()

/** Every channel with unread, keyed by channel id. Older servers have no endpoint: read as nothing unread. */
export function useChannelUnreadMap(): Map<number, ChannelUnread> {
  const { data } = useQuery({
    queryKey: channelUnreadKey,
    queryFn: async () => (await api.channelUnreadList().catch(() => ({ channels: [] as ChannelUnread[] }))).channels,
    staleTime: Infinity,
    select: toUnreadMap,
  })
  return data ?? NO_UNREAD
}

function toUnreadMap(list: ChannelUnread[]): Map<number, ChannelUnread> {
  return new Map(list.map((u) => [u.channelId, u]))
}

/** Unread messages (main timeline or a thread) — not attention, which is separate. */
export function hasUnread(u: ChannelUnread | undefined): boolean {
  return u != null && (u.unread > 0 || Object.keys(u.threads).length > 0)
}

/** How many things in the channel wait on you (approvals, a "waiting" thread you haven't read). */
export function attentionOf(u: ChannelUnread | undefined): number {
  return u?.attention ?? 0
}

/** Fold one channel's fresh counts (a `channel_unread` event) into the cache. */
export function applyChannelUnread(queryClient: QueryClient, unread: ChannelUnread): void {
  queryClient.setQueryData<ChannelUnread[]>(channelUnreadKey, (prev) => {
    if (!prev) return prev
    const rest = prev.filter((u) => u.channelId !== unread.channelId)
    return hasUnread(unread) || attentionOf(unread) > 0 ? [...rest, unread] : rest
  })
}

/** A deleted channel: drop its entry (the server says so too, for other clients). */
export function removeChannelUnread(queryClient: QueryClient, channelId: number): void {
  queryClient.setQueryData<ChannelUnread[]>(channelUnreadKey, (prev) => prev?.filter((u) => u.channelId !== channelId))
}

function patchUnread(queryClient: QueryClient, channelId: number, patch: (u: ChannelUnread) => ChannelUnread): void {
  const current = queryClient.getQueryData<ChannelUnread[]>(channelUnreadKey)?.find((u) => u.channelId === channelId)
  if (current) applyChannelUnread(queryClient, patch(current))
}

/**
 * Keep a channel (or, with `rootMessageId`, one of its threads) read while it is
 * on screen and the window has focus: whenever its cached count goes above zero,
 * clear it locally at once and tell the server (which tells the other devices).
 * A window in the background leaves new messages unread until you come back.
 */
export function useAutoMarkRead(channelId: number | null, rootMessageId: number | null = null, enabled = true): void {
  const queryClient = useQueryClient()
  const unread = useChannelUnreadMap().get(channelId ?? 0)
  const count = rootMessageId == null ? (unread?.unread ?? 0) : (unread?.threads[rootMessageId] ?? 0)

  useEffect(() => {
    if (!enabled || channelId == null || count === 0) return
    const mark = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      if (rootMessageId == null) {
        patchUnread(queryClient, channelId, (u) => ({ ...u, unread: 0 }))
        void api.channelMarkRead(channelId).catch(() => {})
      } else {
        patchUnread(queryClient, channelId, (u) => {
          const threads = { ...u.threads }
          delete threads[rootMessageId]
          return { ...u, threads }
        })
        void api.channelThreadMarkRead(channelId, rootMessageId).catch(() => {})
      }
    }
    mark()
    window.addEventListener('focus', mark)
    document.addEventListener('visibilitychange', mark)
    return () => {
      window.removeEventListener('focus', mark)
      document.removeEventListener('visibilitychange', mark)
    }
  }, [enabled, channelId, rootMessageId, count, queryClient])
}
