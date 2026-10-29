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

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((value) => b.has(value))

// Entries are re-parsed from tool parts on every pass, so compare by content.
// They are small (one per external agent run), so JSON is cheap enough.
const sameMap = <V,>(a: Map<string, V>, b: Map<string, V>) =>
  a.size === b.size &&
  [...a].every(([key, value]) => {
    const other = b.get(key)
    return other === value || (other !== undefined && JSON.stringify(other) === JSON.stringify(value))
  })

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
      // Every streamed chunk re-applies the last message into fresh collections.
      // Keep the ones whose content didn't change, and skip the state update (a
      // second, synchronous render of the whole chat panel per chunk, since this
      // is a layout effect) when none did.
      const previous = entry.state
      const backgroundTaskIds = sameSet(previous.backgroundTaskIds, nextState.backgroundTaskIds)
        ? previous.backgroundTaskIds
        : nextState.backgroundTaskIds
      const externalAgentTasksById = sameMap(previous.externalAgentTasksById, nextState.externalAgentTasksById)
        ? previous.externalAgentTasksById
        : nextState.externalAgentTasksById
      const externalAgentNotificationsByTaskId = sameMap(previous.externalAgentNotificationsByTaskId, nextState.externalAgentNotificationsByTaskId)
        ? previous.externalAgentNotificationsByTaskId
        : nextState.externalAgentNotificationsByTaskId
      if (
        backgroundTaskIds !== previous.backgroundTaskIds ||
        externalAgentTasksById !== previous.externalAgentTasksById ||
        externalAgentNotificationsByTaskId !== previous.externalAgentNotificationsByTaskId
      ) {
        entry.state = { backgroundTaskIds, externalAgentTasksById, externalAgentNotificationsByTaskId }
        setChatIndexState(entry.state)
      }
    }
  }, [chatId, getChatIndexEntry, historyLoaded, messages])

  return useMemo(() => ({
    backgroundTaskIds: chatIndexState.backgroundTaskIds,
    externalAgentTasks: Array.from(chatIndexState.externalAgentTasksById.values()),
    externalAgentNotificationsByTaskId: chatIndexState.externalAgentNotificationsByTaskId,
  }), [chatIndexState])
}
