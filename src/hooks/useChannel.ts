import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { subscribeSse } from '@/lib/sse'
import { useChannelStore } from '@/stores/channel-store'
import type { ChannelMessage, ChannelEvent } from '@/types/channel'

interface UseChannelOptions {
  channelId: number | null
}

const PAGE_SIZE = 50

/** How long a `typing_start` is trusted before we clear it ourselves, in case
 *  the matching `typing_stop` never arrives (agent crashed, stream dropped). */
const TYPING_TTL_MS = 30_000

export function useChannel({ channelId }: UseChannelOptions) {
  const [messages, setMessages] = useState<ChannelMessage[]>([])
  const [threadMessages, setThreadMessages] = useState<ChannelMessage[]>([])
  const [typingAgentIds, setTypingAgentIds] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const typingTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  // Field selectors, not `useChannelStore()`. This hook backs the whole chat
  // view, so subscribing to the entire store re-rendered every message on any
  // unrelated store write — including the `setThreadRoots` below, which this
  // hook itself performs on every new message.
  const threadRootId = useChannelStore((s) => s.threadRootId)
  const setThreadRoots = useChannelStore((s) => s.setThreadRoots)

  // Load initial messages when channel changes
  useEffect(() => {
    if (!channelId) {
      setMessages([])
      setHasMore(false)
      return
    }
    setLoading(true)
    api.channelMessageList(channelId, { limit: PAGE_SIZE })
      .then((res) => {
        setMessages(res.messages.filter((m) => !m.threadRootId))
        setHasMore(res.hasMore)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [channelId])

  // Mirrors of the paging state that `loadMore` reads. Kept in refs so its
  // identity depends on `channelId` alone: it feeds ChannelChat's scroll
  // handler, and taking `messages`/`loadingMore` as deps rebuilt that handler on
  // every single incoming message.
  const oldestIdRef = useRef<number | null>(null)
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
      const older = res.messages.filter((m) => !m.threadRootId)
      setMessages((prev) => [...older, ...prev])
      setHasMore(res.hasMore)
    } catch (err) {
      console.error(err)
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [channelId])

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
    api.channelThreadReplies(channelId, threadRootId)
      .then(({ replies }) => setThreadMessages(replies))
      .catch(console.error)
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
        // Thread reply
        setThreadMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev
          return [...prev, msg]
        })
        // Update replyCount on root message
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msg.threadRootId
              ? { ...m, replyCount: m.replyCount + 1, lastReplyAt: msg.createdAt }
              : m
          )
        )
      } else {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev
          return [...prev, msg]
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
    } else if (event.type === 'agent_status') {
      // Update session status in store in real time
      useChannelStore.getState().updateSessionStatus(event.agentId, event.status)
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
  }, [clearTyping])

  // SSE subscription
  useEffect(() => {
    if (!channelId) return
    const subscription = subscribeSse<ChannelEvent>({
      url: () => api.channelStreamUrl(channelId),
      onEvent: handleEvent,
    })
    return () => subscription.close()
  }, [channelId, handleEvent])

  // Drop pending typing timers on unmount / channel switch — they'd otherwise
  // keep a reference to this hook's setState for up to TYPING_TTL_MS.
  useEffect(() => {
    const timers = typingTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const sendMessage = useCallback(async (content: string) => {
    if (!channelId) return
    const { message } = await api.channelMessageCreate(channelId, {
      senderType: 'human',
      senderName: 'you',
      content,
    })
    setMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) return prev
      return [...prev, message]
    })
  }, [channelId])

  const sendThreadReply = useCallback(async (content: string) => {
    if (!channelId || !threadRootId) return
    const { message } = await api.channelThreadReply(channelId, threadRootId, {
      senderType: 'human',
      senderName: 'you',
      content,
    })
    setThreadMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) return prev
      return [...prev, message]
    })
    setMessages((prev) =>
      prev.map((m) =>
        m.id === threadRootId
          ? { ...m, replyCount: m.replyCount + 1, lastReplyAt: message.createdAt }
          : m
      )
    )
  }, [channelId, threadRootId])

  return {
    messages,
    threadMessages,
    typingAgentIds,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    sendMessage,
    sendThreadReply,
  }
}
