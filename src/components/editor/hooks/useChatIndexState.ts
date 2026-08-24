import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import {
  applyMessageToChatIndex,
  buildChatIndexState,
  createEmptyChatIndexSources,
  createEmptyChatIndexState,
  getChatIndexMessageSignature,
  type ChatIndexSources,
  type ChatIndexState,
} from '../utils/chat-derived'

export function useChatIndexState({
  chatId,
  messages,
  historyLoaded,
}: {
  chatId: string
  messages: UIMessage[]
  historyLoaded: boolean
}) {
  const chatIndexesByChatRef = useRef(new Map<string, {
    state: ChatIndexState
    sources: ChatIndexSources
  }>())
  const [chatIndexState, setChatIndexState] = useState<ChatIndexState>(createEmptyChatIndexState)

  const getChatIndexEntry = useCallback((targetChatId: string) => {
    const existing = chatIndexesByChatRef.current.get(targetChatId)
    if (existing) return existing

    const created = {
      state: createEmptyChatIndexState(),
      sources: createEmptyChatIndexSources(),
    }
    chatIndexesByChatRef.current.set(targetChatId, created)
    return created
  }, [])

  useEffect(() => {
    setChatIndexState(getChatIndexEntry(chatId).state)
  }, [chatId, getChatIndexEntry])

  useLayoutEffect(() => {
    if (!historyLoaded) return

    const lastMessage = messages[messages.length - 1]
    const lastMessageSignature = getChatIndexMessageSignature(lastMessage)
    const entry = getChatIndexEntry(chatId)
    const sources = entry.sources

    const resetState = () => {
      const nextState = createEmptyChatIndexState()
      const alreadyEmpty =
        sources.initialized &&
        sources.processedCount === 0 &&
        entry.state.backgroundTaskIds.size === 0 &&
        entry.state.externalAgentTasksById.size === 0 &&
        entry.state.externalAgentNotificationsByTaskId.size === 0

      entry.sources = {
        ...createEmptyChatIndexSources(),
        initialized: true,
        processedCount: messages.length,
        lastMessageId: lastMessage?.id,
        lastMessageSignature,
      }
      entry.state = nextState
      if (!alreadyEmpty) {
        setChatIndexState(nextState)
      }
    }

    if (messages.length === 0) {
      resetState()
      return
    }

    const shouldRebuild =
      !sources.initialized ||
      sources.processedCount > messages.length ||
      (sources.processedCount > 0 &&
        messages[Math.min(sources.processedCount - 1, messages.length - 1)]?.id !== sources.lastMessageId)

    if (shouldRebuild) {
      const rebuilt = buildChatIndexState(messages)
      rebuilt.sources.lastMessageSignature = lastMessageSignature
      entry.sources = rebuilt.sources
      entry.state = rebuilt.state
      setChatIndexState(rebuilt.state)
      return
    }

    let nextState = entry.state
    let changed = false

    const cloneState = () => {
      if (changed) return
      nextState = {
        backgroundTaskIds: new Set(nextState.backgroundTaskIds),
        externalAgentTasksById: new Map(nextState.externalAgentTasksById),
        externalAgentNotificationsByTaskId: new Map(nextState.externalAgentNotificationsByTaskId),
      }
      changed = true
    }

    for (let index = sources.processedCount; index < messages.length; index += 1) {
      cloneState()
      applyMessageToChatIndex(nextState, messages[index])
    }

    const lastMessageChanged =
      sources.lastMessageId === lastMessage?.id &&
      sources.lastMessageSignature !== lastMessageSignature

    if (lastMessageChanged && lastMessage) {
      cloneState()
      applyMessageToChatIndex(nextState, lastMessage)
    }

    sources.initialized = true
    sources.processedCount = messages.length
    sources.lastMessageId = lastMessage?.id
    sources.lastMessageSignature = lastMessageSignature

    if (changed) {
      entry.state = nextState
      setChatIndexState(nextState)
    }
  }, [chatId, getChatIndexEntry, historyLoaded, messages])

  return useMemo(() => ({
    backgroundTaskIds: chatIndexState.backgroundTaskIds,
    externalAgentTasks: Array.from(chatIndexState.externalAgentTasksById.values()),
    externalAgentNotificationsByTaskId: chatIndexState.externalAgentNotificationsByTaskId,
  }), [chatIndexState])
}
