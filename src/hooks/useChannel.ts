import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { applyThreadUpdate, applyWaitingSessions, channelKeys } from '@/lib/channel-queries'
import { subscribeSse } from '@/lib/sse'
import { useChannelStore } from '@/stores/channel-store'
import type { ChannelAttachment, ChannelMessage, ChannelEvent, ThreadRootActivity } from '@/types/channel'

interface UseChannelOptions {
  channelId: number | null
}

const PAGE_SIZE = 50
const NO_MESSAGES: ChannelMessage[] = []

/** How long a `typing_start` is trusted before we clear it ourselves, in case
 *  the matching `typing_stop` never arrives (agent crashed, stream dropped). */
const TYPING_TTL_MS = 30_000

function mergeMessages(snapshot: ChannelMessage[], live: ChannelMessage[]): ChannelMessage[] {
  const byId = new Map(snapshot.map((message) => [message.id, message]))
  for (const message of live) {
    if (!byId.has(message.id)) byId.set(message.id, message)
  }
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

export function useChannel({ channelId }: UseChannelOptions) {
  const [messages, setMessages] = useState<ChannelMessage[]>([])
  const [threadMessages, setThreadMessages] = useState<ChannelMessage[]>([])
  const [typingAgentIds, setTypingAgentIds] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const typingTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  const queryClient = useQueryClient()
  const threadActivity = useRef(new Map<number, ThreadRootActivity>())
  const legacyReplies = useRef(new Set<number>())
  const applyThreadActivity = useCallback((message: ChannelMessage) => {
    const activity = threadActivity.current.get(message.id)
    return activity && activity.replyCount > message.replyCount ? { ...message, ...activity } : message
  }, [])
  const updateReplyCount = useCallback((reply: ChannelMessage, activity?: ThreadRootActivity) => {
    if (activity) {
      const previous = threadActivity.current.get(activity.id)
      if (previous && previous.replyCount >= activity.replyCount) return
      threadActivity.current.set(activity.id, activity)
      setMessages((prev) => prev.map((message) => message.id === activity.id ? applyThreadActivity(message) : message))
      return
    }
    // Older nodes send only the reply. Count its POST and SSE delivery once.
    if (reply.threadRootId == null || legacyReplies.current.has(reply.id)) return
    legacyReplies.current.add(reply.id)
    setMessages((prev) =>
      prev.map((m) =>
        m.id === reply.threadRootId
          ? { ...m, replyCount: m.replyCount + 1, lastReplyAt: Math.max(m.lastReplyAt ?? 0, reply.createdAt) }
          : m
      )
    )
  }, [applyThreadActivity])

  // Field selectors, not `useChannelStore()`. This hook backs the whole chat
  // view, so subscribing to the entire store re-rendered every message on any
  // unrelated store write — including the `setThreadRoots` below, which this
  // hook itself performs on every new message.
  const threadRootId = useChannelStore((s) => s.threadRootId)
  const setThreadRoots = useChannelStore((s) => s.setThreadRoots)

  // Load initial messages when channel changes
  useEffect(() => {
    threadActivity.current.clear()
    legacyReplies.current.clear()
    if (!channelId) {
      setMessages([])
      setHasMore(false)
      setLoading(false)
      return
    }
    // A new channel starts empty, and a late answer for the previous one is dropped.
    let cancelled = false
    setMessages([])
    setHasMore(false)
    setLoading(true)
    api.channelMessageList(channelId, { limit: PAGE_SIZE })
      .then((res) => {
        if (cancelled) return
        setMessages((prev) => mergeMessages(res.messages.filter((m) => !m.threadRootId), prev).map(applyThreadActivity))
        setHasMore(res.hasMore)
      })
      .catch((err: unknown) => {
        if (!cancelled) console.error(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyThreadActivity, channelId])

  // Mirrors of the paging state that `loadMore` reads. Kept in refs so its
  // identity depends on `channelId` alone: it feeds ChannelChat's scroll
  // handler, and taking `messages`/`loadingMore` as deps rebuilt that handler on
  // every single incoming message.
  const oldestIdRef = useRef<number | null>(null)
  const currentChannelRef = useRef(channelId)
  currentChannelRef.current = channelId
  const hasMoreRef = useRef(false)
  const loadingMoreRef = useRef(false)
  useEffect(() => {
    oldestIdRef.current = messages[0]?.id ?? null
  }, [messages])
  useEffect(() => {
    hasMoreRef.current = hasMore
  }, [hasMore])

  // Load older messages (called when scrolling to top)
  const loadMore = useCallback(async () => {
    if (!channelId || !hasMoreRef.current || loadingMoreRef.current) return
    const before = oldestIdRef.current
    if (before == null) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const res = await api.channelMessageList(channelId, { before, limit: PAGE_SIZE })
      // The user switched channels while this page was loading.
      if (currentChannelRef.current !== channelId) return
      const older = res.messages.filter((m) => !m.threadRootId)
      setMessages((prev) => mergeMessages(older, prev).map(applyThreadActivity))
      setHasMore(res.hasMore)
    } catch (err) {
      console.error(err)
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [applyThreadActivity, channelId])

  // Sync thread roots to store for sidebar display
  useEffect(() => {
    const roots = messages.filter((m) => m.replyCount > 0)
    setThreadRoots(roots)
  }, [messages, setThreadRoots])

  // Load thread replies when threadRootId changes
  useEffect(() => {
    if (!channelId || !threadRootId) {
      setThreadMessages([])
      return
    }
    let cancelled = false
    setThreadMessages((prev) => prev.filter((m) => m.threadRootId === threadRootId))
    api.channelThreadReplies(channelId, threadRootId)
      .then(({ replies }) => {
        if (!cancelled) setThreadMessages((prev) => mergeMessages(replies, prev.filter((m) => m.threadRootId === threadRootId)))
      })
      .catch((err: unknown) => {
        if (!cancelled) console.error(err)
      })
    return () => {
      cancelled = true
    }
  }, [channelId, threadRootId])

  const clearTyping = useCallback((agentId: number) => {
    setTypingAgentIds((prev) => {
      if (!prev.has(agentId)) return prev
      const next = new Set(prev)
      next.delete(agentId)
      return next
    })
    const existing = typingTimers.current.get(agentId)
    if (existing) {
      clearTimeout(existing)
      typingTimers.current.delete(agentId)
    }
  }, [])

  const handleEvent = useCallback((event: ChannelEvent) => {
    if (event.type === 'channel_message') {
      const msg = event.data
      if (msg.threadRootId) {
        if (msg.threadRootId === useChannelStore.getState().threadRootId) {
          setThreadMessages((prev) => mergeMessages(prev.filter((m) => m.threadRootId === msg.threadRootId), [msg]))
        }
        updateReplyCount(msg, event.threadRoot)
      } else {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev
          return [...prev, applyThreadActivity(msg)]
        })
      }
      // Stop typing for this agent if it's an agent message
      if (msg.senderType === 'agent' && msg.senderId) {
        clearTyping(msg.senderId)
      }
    } else if (event.type === 'message_updated') {
      const msg = event.data
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)))
      setThreadMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)))
    } else if (event.type === 'thread_updated') {
      applyThreadUpdate(queryClient, event.data)
    } else if (event.type === 'sessions_waiting') {
      if (channelId) applyWaitingSessions(queryClient, channelId, event.data)
    } else if (event.type === 'agent_status') {
      // Update session status in store in real time
      useChannelStore.getState().updateSessionStatus(event.agentId, event.projectId, event.status)
    } else if (event.type === 'typing_start') {
      const { agentId } = event
      // Clear first so a repeated typing_start replaces its predecessor's timer
      // instead of leaking it.
      clearTyping(agentId)
      setTypingAgentIds((prev) => new Set([...prev, agentId]))
      const timer = setTimeout(() => {
        setTypingAgentIds((prev) => {
          const next = new Set(prev)
          next.delete(agentId)
          return next
        })
        typingTimers.current.delete(agentId)
      }, TYPING_TTL_MS)
      typingTimers.current.set(agentId, timer)
    } else if (event.type === 'typing_stop') {
      clearTyping(event.agentId)
    }
  }, [applyThreadActivity, channelId, clearTyping, queryClient, updateReplyCount])

  // SSE subscription
  useEffect(() => {
    if (!channelId) return
    const subscription = subscribeSse<ChannelEvent>({
      url: () => api.channelStreamUrl(channelId),
      onEvent: handleEvent,
      // Thread updates missed while the stream was down: read the list again.
      onError: () => {
        void queryClient.invalidateQueries({ queryKey: channelKeys.threads(channelId) })
        void queryClient.invalidateQueries({ queryKey: channelKeys.waiting(channelId) })
      },
    })
    return () => subscription.close()
  }, [channelId, handleEvent, queryClient])

  // Drop pending typing timers on unmount / channel switch — they'd otherwise
  // keep a reference to this hook's setState for up to TYPING_TTL_MS.
  useEffect(() => {
    const timers = typingTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const sendMessage = useCallback(async (content: string, attachments: ChannelAttachment[] = []) => {
    if (!channelId) return
    const { message } = await api.channelMessageCreate(channelId, {
      senderType: 'human',
      senderName: 'you',
      content,
      ...(attachments.length > 0 ? { attachments } : {}),
    })
    if (currentChannelRef.current !== channelId) return
    setMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) return prev
      return [...prev, message]
    })
  }, [channelId])

  const sendThreadReply = useCallback(async (content: string, attachments: ChannelAttachment[] = []) => {
    if (!channelId || !threadRootId) return
    const { message, threadRoot } = await api.channelThreadReply(channelId, threadRootId, {
      senderType: 'human',
      senderName: 'you',
      content,
      ...(attachments.length > 0 ? { attachments } : {}),
    })
    if (currentChannelRef.current !== channelId) return
    if (useChannelStore.getState().threadRootId === threadRootId) {
      setThreadMessages((prev) => mergeMessages(prev.filter((m) => m.threadRootId === threadRootId), [message]))
    }
    updateReplyCount(message, threadRoot)
  }, [channelId, threadRootId, updateReplyCount])

  return {
    messages,
    threadMessages: threadMessages[0]?.threadRootId === threadRootId ? threadMessages : NO_MESSAGES,
    typingAgentIds,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    sendMessage,
    sendThreadReply,
  }
}
