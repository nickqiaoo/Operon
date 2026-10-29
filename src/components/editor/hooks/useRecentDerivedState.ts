import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import {
  createEmptyRecentDerivedState,
  createEmptyRecentDerivedSources,
  buildRecentDerivedState,
  buildTodosState,
  findLatestCodexMetadataBefore,
  findLatestContextMetadataBefore,
  getFirstUserTitleFromMessage,
  getRecentDerivedMessageSignature,
  reduceTodosFromMessage,
  type RecentDerivedState,
  type RecentDerivedSources,
  type TodoEntry,
} from '../utils/chat-derived'
import { extractCompacted, extractContextUsage } from '../utils/chatMetadata'
import type { DetailedContextUsage } from '@/types/context-usage'

type ContextUsageView = {
  usage: NonNullable<ReturnType<typeof extractContextUsage>>['usage']
  maxTokens?: number
  usedTokens?: number
  detailedContextUsage?: DetailedContextUsage
} | null

type CodexUsageDetailsView = {
  account: NonNullable<ReturnType<typeof extractContextUsage>>['codexAccount']
  rateLimits: NonNullable<ReturnType<typeof extractContextUsage>>['codexRateLimits']
} | null

const sameTodos = (a: TodoEntry[], b: TodoEntry[]) =>
  a === b ||
  (a.length === b.length &&
    a.every((todo, index) => {
      const other = b[index]
      return todo.id === other.id && todo.content === other.content && todo.activeForm === other.activeForm && todo.status === other.status
    }))

type UsageMetadata = RecentDerivedState['latestContextMetadata']

// extractContextUsage wraps the message's metadata fields in a fresh object on
// every call, so compare what it wraps.
const sameMetadata = (a: UsageMetadata, b: UsageMetadata) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.usage === b.usage &&
    a.contextUsage === b.contextUsage &&
    a.detailedContextUsage === b.detailedContextUsage &&
    a.codexAccount === b.codexAccount &&
    a.codexRateLimits === b.codexRateLimits &&
    a.claudeRateLimits === b.claudeRateLimits)

/**
 * Whether two states look the same to ChatPanel. `lastAssistant` is left out on
 * purpose: streaming replaces it on every chunk and nothing renders from it.
 */
const sameRenderedState = (a: RecentDerivedState, b: RecentDerivedState) =>
  a.firstUserTitle === b.firstUserTitle &&
  a.compactedInfo === b.compactedInfo &&
  a.latestContextMetadata === b.latestContextMetadata &&
  a.latestCodexMetadata === b.latestCodexMetadata &&
  sameTodos(a.latestTodos, b.latestTodos)

export function useRecentDerivedState<TTodoPart>({
  chatId,
  messages,
  historyLoaded,
  isTodoWriteTool,
  extractTodosFromPart,
}: {
  chatId: string
  messages: UIMessage[]
  historyLoaded: boolean
  isTodoWriteTool: (part: TTodoPart) => boolean
  extractTodosFromPart: (part: TTodoPart) => Array<{ id?: string; content: string; activeForm?: string; status: string }>
}) {
  const recentDerivedByChatRef = useRef(new Map<string, {
    state: RecentDerivedState
    sources: RecentDerivedSources
  }>())
  const [recentDerivedState, setRecentDerivedState] = useState<RecentDerivedState>(createEmptyRecentDerivedState)
  const isTodoToolPart = useCallback(
    (part: UIMessage['parts'][number]) => isTodoWriteTool(part as TTodoPart),
    [isTodoWriteTool],
  )
  const extractTodos = useCallback(
    (part: UIMessage['parts'][number]) => extractTodosFromPart(part as TTodoPart),
    [extractTodosFromPart],
  )

  const getRecentDerivedEntry = useCallback((targetChatId: string) => {
    const existing = recentDerivedByChatRef.current.get(targetChatId)
    if (existing) return existing

    const created = {
      state: createEmptyRecentDerivedState(),
      sources: createEmptyRecentDerivedSources(),
    }
    recentDerivedByChatRef.current.set(targetChatId, created)
    return created
  }, [])

  useEffect(() => {
    setRecentDerivedState(getRecentDerivedEntry(chatId).state)
  }, [chatId, getRecentDerivedEntry])

  useLayoutEffect(() => {
    if (!historyLoaded) return

    const lastMessage = messages[messages.length - 1]
    const lastMessageSignature = getRecentDerivedMessageSignature(lastMessage)
    const entry = getRecentDerivedEntry(chatId)
    const sources = entry.sources

    const resetState = () => {
      const nextState = createEmptyRecentDerivedState()
      const alreadyEmpty =
        sources.initialized &&
        sources.processedCount === 0 &&
        entry.state.firstUserTitle === null &&
        entry.state.lastAssistant === undefined &&
        entry.state.compactedInfo === null &&
        entry.state.latestContextMetadata === null &&
        entry.state.latestCodexMetadata === null &&
        entry.state.latestTodos.length === 0

      entry.sources = {
        ...createEmptyRecentDerivedSources(),
        initialized: true,
        processedCount: messages.length,
        lastMessageId: lastMessage?.id,
        lastMessageSignature,
      }
      entry.state = nextState
      if (!alreadyEmpty) {
        setRecentDerivedState(nextState)
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
      const rebuilt = buildRecentDerivedState(messages, isTodoToolPart, extractTodos)
      rebuilt.sources.lastMessageSignature = lastMessageSignature
      entry.sources = rebuilt.sources
      entry.state = rebuilt.state
      setRecentDerivedState(rebuilt.state)
      return
    }

    let nextState = entry.state
    let changed = false

    const updateState = (updater: (draft: RecentDerivedState) => void) => {
      if (!changed) {
        nextState = {
          ...nextState,
          latestTodos: [...nextState.latestTodos],
        }
        changed = true
      }
      updater(nextState)
    }

    for (let index = sources.processedCount; index < messages.length; index += 1) {
      const message = messages[index]
      const title = getFirstUserTitleFromMessage(message)
      if (!nextState.firstUserTitle && title) {
        updateState((draft) => {
          draft.firstUserTitle = title
        })
      }

      if (message.role !== 'assistant') continue

      const metadata = extractContextUsage(message)
      const todoReduction = reduceTodosFromMessage(
        nextState.latestTodos,
        message,
        isTodoToolPart,
        extractTodos,
      )
      const compacted = extractCompacted(message)

      updateState((draft) => {
        draft.lastAssistant = message
        draft.compactedInfo = compacted
        if (metadata?.usage || metadata?.detailedContextUsage) {
          const prev = draft.latestContextMetadata
          draft.latestContextMetadata = {
            ...metadata,
            usage: metadata.usage ?? prev?.usage,
            contextUsage: metadata.contextUsage ?? prev?.contextUsage,
            detailedContextUsage: metadata.detailedContextUsage ?? prev?.detailedContextUsage,
          }
          sources.contextMessageId = message.id
        }
        if (metadata?.codexAccount || metadata?.codexRateLimits) {
          draft.latestCodexMetadata = metadata
          sources.codexMessageId = message.id
        }
        if (todoReduction.changed) {
          draft.latestTodos = todoReduction.todos
          sources.todoMessageId = message.id
        }
      })
    }

    const lastMessageChanged =
      sources.lastMessageId === lastMessage?.id &&
      sources.lastMessageSignature !== lastMessageSignature

    if (lastMessageChanged && lastMessage?.role === 'assistant') {
      const metadata = extractContextUsage(lastMessage)
      const todoState = buildTodosState(
        messages,
        messages.length - 1,
        isTodoToolPart,
        extractTodos,
      )
      const compacted = extractCompacted(lastMessage)

      updateState((draft) => {
        draft.lastAssistant = lastMessage
        draft.compactedInfo = compacted

        if (metadata?.usage || metadata?.detailedContextUsage) {
          const prev = draft.latestContextMetadata
          draft.latestContextMetadata = {
            ...metadata,
            usage: metadata.usage ?? prev?.usage,
            contextUsage: metadata.contextUsage ?? prev?.contextUsage,
            detailedContextUsage: metadata.detailedContextUsage ?? prev?.detailedContextUsage,
          }
          sources.contextMessageId = lastMessage.id
        } else if (sources.contextMessageId === lastMessage.id) {
          const fallback = findLatestContextMetadataBefore(messages, messages.length - 2)
          draft.latestContextMetadata = fallback.metadata
          sources.contextMessageId = fallback.messageId
        }

        if (metadata?.codexAccount || metadata?.codexRateLimits) {
          draft.latestCodexMetadata = metadata
          sources.codexMessageId = lastMessage.id
        } else if (sources.codexMessageId === lastMessage.id) {
          const fallback = findLatestCodexMetadataBefore(messages, messages.length - 2)
          draft.latestCodexMetadata = fallback.metadata
          sources.codexMessageId = fallback.messageId
        }

        draft.latestTodos = todoState.todos
        sources.todoMessageId = todoState.messageId
      })
    }

    sources.initialized = true
    sources.processedCount = messages.length
    sources.lastMessageId = lastMessage?.id
    sources.lastMessageSignature = lastMessageSignature

    if (changed) {
      const previous = entry.state
      // Keep the previous metadata objects when nothing in them changed, so the
      // usage views derived from them (and the Session panel's cards) stay put.
      if (sameMetadata(previous.latestContextMetadata, nextState.latestContextMetadata)) {
        nextState.latestContextMetadata = previous.latestContextMetadata
      }
      if (sameMetadata(previous.latestCodexMetadata, nextState.latestCodexMetadata)) {
        nextState.latestCodexMetadata = previous.latestCodexMetadata
      }
      entry.state = nextState
      // This runs in a layout effect, so every setState here re-renders the whole
      // chat panel a second time — once per streamed chunk, since each one
      // rewrites lastAssistant and rebuilds the todo list. Only re-render when
      // something that is shown actually changed.
      if (!sameRenderedState(previous, nextState)) setRecentDerivedState(nextState)
    }
  }, [chatId, extractTodos, getRecentDerivedEntry, historyLoaded, isTodoToolPart, messages])

  // Memoized so the panels these feed (Session usage cards) can skip re-rendering.
  const latestContextMetadata = recentDerivedState.latestContextMetadata
  const contextUsage = useMemo((): ContextUsageView => {
    const meta = latestContextMetadata
    if (!meta?.usage && !meta?.detailedContextUsage) return null
    const usage = meta.usage
    const detailed = meta.detailedContextUsage
    // Prefer detailed context usage (pushed via metadata) over simple contextUsage
    if (detailed) {
      return {
        usage,
        maxTokens: detailed.maxTokens,
        usedTokens: detailed.totalTokens,
        detailedContextUsage: detailed,
      }
    }
    // promptTokens from provider is authoritative; otherwise inputTokens
    // is already the total (noCacheInput + cacheRead + cacheWrite) in the AI SDK
    const estimatedTokens = meta.contextUsage?.promptTokens ?? (usage?.inputTokens ?? 0)
    return {
      usage,
      maxTokens: meta.contextUsage?.contextWindow,
      usedTokens: estimatedTokens > 0 ? estimatedTokens : undefined,
    }
  }, [latestContextMetadata])

  const latestCodexMetadata = recentDerivedState.latestCodexMetadata
  const codexUsageDetails = useMemo((): CodexUsageDetailsView =>
    latestCodexMetadata?.codexAccount || latestCodexMetadata?.codexRateLimits
      ? {
          account: latestCodexMetadata.codexAccount,
          rateLimits: latestCodexMetadata.codexRateLimits,
        }
      : null,
  [latestCodexMetadata])

  return {
    firstUserTitle: recentDerivedState.firstUserTitle,
    compactedInfo: recentDerivedState.compactedInfo,
    latestTodos: recentDerivedState.latestTodos,
    contextUsage,
    codexUsageDetails,
  }
}
