import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { applyThreadUpdate, applyWaitingSessions, applyWorkingAgents, channelKeys } from '@/lib/channel-queries'
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

/**
 * Ids for messages not yet confirmed: above any real id (a global sequence),
 * so they sort last, and rising, so several in flight keep their order.
 */
const LOCAL_ID_BASE = 2 ** 52
let nextLocalId = LOCAL_ID_BASE

export function isLocalMessage(message: Pick<ChannelMessage, 'localState'>): boolean {
  return message.localState != null
}

export function localMessage(channelId: number, threadRootId: number | null, content: string, attachments: ChannelAttachment[]): ChannelMessage {
  nextLocalId += 1
  return {
    id: nextLocalId,
    channelId,
    threadRootId,
    senderType: 'human',
    senderId: null,
    senderName: 'you',
    content,
    replyCount: 0,
    lastReplyAt: null,
    attachments,
    createdAt: Date.now(),
    localState: 'sending',
  }
}

/**
 * The saved copy of one of your messages arrived (POST answer or stream, in
 * either order): drop the oldest local copy it stands for and keep the saved
 * one once.
 */
export function confirmLocal(list: ChannelMessage[], saved: ChannelMessage, localId?: number): ChannelMessage[] {
  let dropId = localId
  if (dropId == null && saved.senderType === 'human') {
    dropId = list.find((m) => m.localState === 'sending' && m.threadRootId === saved.threadRootId && m.content === saved.content)?.id
  }
  const rest = dropId == null ? list : list.filter((m) => m.id !== dropId)
  return rest.some((m) => m.id === saved.id) ? rest : mergeMessages(rest, [saved])
}

function setLocalState(list: ChannelMessage[], localId: number, localState: ChannelMessage['localState']): ChannelMessage[] {
  return list.map((m) => (m.id === localId ? { ...m, localState } : m))
}

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
  // Read by retrySend, so its identity doesn't change with every message.
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const threadMessagesRef = useRef(threadMessages)
  threadMessagesRef.current = threadMessages
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
    if (!channelId) {
      setThreadMessages([])
      return
    }
    // Closing keeps the replies: the panel still shows them while it slides
    // away. Opening another thread filters them out below.
    if (!threadRootId) return
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
          setThreadMessages((prev) => confirmLocal(prev.filter((m) => m.threadRootId === msg.threadRootId), msg))
        }
        updateReplyCount(msg, event.threadRoot)
      } else {
        setMessages((prev) => confirmLocal(prev, applyThreadActivity(msg)))
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
    } else if (event.type === 'sessions_working') {
      if (channelId) applyWorkingAgents(queryClient, channelId, event.agentIds)
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
      // These queries never go stale on their own (staleTime: Infinity) — the
      // stream keeps them current. So whatever changed while no stream was open
      // (this channel was off screen, or the connection dropped) is read again
      // once one is: otherwise coming back to the channel after the agents
      // finished still shows them "working" from the cached list.
      onOpen: () => {
        void queryClient.invalidateQueries({ queryKey: channelKeys.threads(channelId) })
        void queryClient.invalidateQueries({ queryKey: channelKeys.waiting(channelId) })
        void queryClient.invalidateQueries({ queryKey: channelKeys.working(channelId) })
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

  // Sending shows your message at once (like the assistant), then swaps in the
  // saved copy; a failed send stays in place, marked, with retry and discard.
  const postMessage = useCallback(async (local: ChannelMessage) => {
    const channel = local.channelId
    const body = {
      senderType: 'human' as const,
      senderName: 'you',
      content: local.content,
      ...(local.attachments && local.attachments.length > 0 ? { attachments: local.attachments } : {}),
    }
    const rootId = local.threadRootId
    const setList = rootId == null ? setMessages : setThreadMessages
    try {
      if (rootId == null) {
        const { message } = await api.channelMessageCreate(channel, body)
        if (currentChannelRef.current !== channel) return
        setMessages((prev) => confirmLocal(prev, message, local.id))
      } else {
        const { message, threadRoot } = await api.channelThreadReply(channel, rootId, body)
        if (currentChannelRef.current !== channel) return
        setThreadMessages((prev) => confirmLocal(prev, message, local.id))
        updateReplyCount(message, threadRoot)
      }
    } catch (error) {
      console.error(error)
      if (currentChannelRef.current === channel) setList((prev) => setLocalState(prev, local.id, 'failed'))
    }
  }, [updateReplyCount])

  const sendMessage = useCallback(async (content: string, attachments: ChannelAttachment[] = []) => {
    if (!channelId) return
    const local = localMessage(channelId, null, content, attachments)
    setMessages((prev) => [...prev, local])
    await postMessage(local)
  }, [channelId, postMessage])

  const sendThreadReply = useCallback(async (content: string, attachments: ChannelAttachment[] = []) => {
    if (!channelId || !threadRootId) return
    const local = localMessage(channelId, threadRootId, content, attachments)
    setThreadMessages((prev) => [...prev.filter((m) => m.threadRootId === threadRootId), local])
    await postMessage(local)
  }, [channelId, threadRootId, postMessage])

  /** Send a failed message again, where it is. */
  const retrySend = useCallback((localId: number) => {
    const local = [...messagesRef.current, ...threadMessagesRef.current].find((m) => m.id === localId && m.localState === 'failed')
    if (!local) return
    const setList = local.threadRootId == null ? setMessages : setThreadMessages
    setList((prev) => setLocalState(prev, localId, 'sending'))
    void postMessage(local)
  }, [postMessage])

  const discardSend = useCallback((localId: number) => {
    setMessages((prev) => prev.filter((m) => m.id !== localId))
    setThreadMessages((prev) => prev.filter((m) => m.id !== localId))
  }, [])

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
    retrySend,
    discardSend,
  }
}
