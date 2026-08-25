import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai'
import { useChat } from '@ai-sdk/react'
import { apiAuthHeaders, getBaseUrl } from '@/lib/api-client'
import { api } from '@/lib/api'
import { subscribeChatPresence } from '@/lib/live-turn-events'
import { useEditorStore } from '@/stores/editor-store'
import { normalizeOutboundMessagePaths } from '../utils/chatMetadata'
import { mergeServerTail, TAIL_SYNC_SIZE } from '../utils/merge-server-tail'
import { normalizeHistoryMessages } from './useChatHistory'
import { trackEvent } from '@/lib/analytics'

const IS_WEB = __APP_TARGET__ === 'web'

// A dropped tunnel/stream connection surfaces as a fetch TypeError whose message
// varies by engine — WebKit "Load failed", Chromium "Failed to fetch", plus the
// "network connection was lost" variants. Only these are auto-resumed: a genuine
// server/model error must stay on screen, not be swallowed by a silent resume.
const isNetworkError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return (
    error.name === 'TypeError' ||
    msg.includes('load failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('connection')
  )
}

const getMessageTextSize = (message: UIMessage | undefined): number => {
  if (!message) return 0

  let size = 0
  for (const part of message.parts ?? []) {
    if ('text' in part && typeof part.text === 'string') {
      size += part.text.length
    }
  }

  return size
}

export function useChatRuntime({
  chatId,
  dbChatId,
  providerId,
  selectedModelProviderId,
  selectedModelId,
  supportsDynamicSwitch,
  model,
  currentMode,
  forcedModeId,
  currentServiceTier,
  thinkingEffort,
  thinkingEffortValues,
  currentWorkspaceId,
  autoRun,
  setTabChatId,
}: {
  chatId: string
  dbChatId?: number
  providerId?: string
  selectedModelProviderId?: string
  selectedModelId?: string
  /** Provider declares `features.dynamicSwitch` — see `canDynamicSwitch` below. */
  supportsDynamicSwitch?: boolean
  model: string
  currentMode: string
  /**
   * Mode this tab must run in regardless of the picker (spawned sub-agent tabs).
   *
   * Takes precedence over `currentMode` because that one is UI state which the
   * provider-config load overwrites with the provider default — a sub-agent tab
   * that raced that load would silently send the ask-before-everything mode and
   * then stall with nobody watching it.
   */
  forcedModeId?: string
  currentServiceTier: string
  thinkingEffort: string
  /** Effort levels valid for the selected model (capability-filtered). */
  thinkingEffortValues?: string[]
  currentWorkspaceId: number | null
  autoRun?: boolean
  setTabChatId: (tabId: string, chatId: number) => void
}) {
  const [historyDbChatId, setHistoryDbChatId] = useState(dbChatId)
  const dbChatIdRef = useRef<number | undefined>(dbChatId)
  const chatBodyRef = useRef<Record<string, unknown>>({})

  // Live-turn ownership. `handledTurnRef` is the latest turn whose stream this
  // surface actually holds, learned from the X-Turn-Id header on both the POST
  // that started it and the GET that attached to it. `pendingTurnRef` parks a
  // turn announced while history is loading or this surface is still mid-stream.
  const handledTurnRef = useRef<string | null>(null)
  const pendingTurnRef = useRef<string | null>(null)
  // Presence can connect before the initial history request settles. Wait for
  // that request instead of issuing a second history fetch for the same open.
  const historyReadyRef = useRef(false)

  /**
   * Does the *node* have a turn running for this chat? `null` until presence
   * answers.
   *
   * Local `status` cannot answer this after a remount: `useChat` starts fresh at
   * 'ready' and only flips to 'streaming' once resume has reattached, so a chat
   * reopened mid-turn looks finished for a moment. Anything that keys off "the
   * turn is over" has to wait for this instead.
   */
  const [liveTurnActive, setLiveTurnActive] = useState<boolean | null>(null)

  useEffect(() => {
    if (dbChatId === undefined || historyDbChatId !== undefined) {
      setHistoryDbChatId(dbChatId)
    }
  }, [dbChatId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    dbChatIdRef.current = dbChatId
  }, [dbChatId])

  // Reset only when the history request will actually re-run — it keys off
  // `historyDbChatId`, not `dbChatId`. Resetting on every `dbChatId` change
  // stranded brand-new chats: their id arrives from the first POST while
  // `historyDbChatId` deliberately stays undefined, so no history request
  // follows, `resumeOnAttach` is never called again, and this stayed false
  // forever — parking every turn the node started (a delivered workflow result,
  // a peer window's turn) instead of attaching to it.
  useEffect(() => {
    historyReadyRef.current = false
  }, [historyDbChatId])

  // Clamp the thinking level to what the selected model actually supports, in
  // case the UI state is stale between a model switch and the reset effect in
  // ChatPanel. When the model has no effort levels (e.g. Haiku), send nothing.
  const normalizedThinkingLevel = (() => {
    if (!thinkingEffort) return undefined
    if (thinkingEffortValues && thinkingEffortValues.length > 0) {
      return thinkingEffortValues.includes(thinkingEffort) ? thinkingEffort : thinkingEffortValues[0]
    }
    if (thinkingEffortValues && thinkingEffortValues.length === 0) return undefined
    return thinkingEffort
  })()

  chatBodyRef.current = {
    providerId: selectedModelProviderId ?? providerId,
    modelId: model || undefined,
    modeId: forcedModeId || currentMode || undefined,
    serviceTier: currentServiceTier || undefined,
    thinkingLevel: normalizedThinkingLevel,
    workspaceId: currentWorkspaceId ?? undefined,
    ...(autoRun ? { skipSnapshot: true } : {}),
  }

  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/ai/chat',
    fetch: async (input, init) => {
      // Desktop target talks to the local server directly and must present the
      // startup token; on web these headers are empty (the tunnel agent stamps
      // the token on the desktop side).
      const headers = new Headers(init?.headers)
      for (const [key, value] of Object.entries(apiAuthHeaders())) headers.set(key, value)
      const response = await fetch(input, { ...init, headers })
      const chatIdHeader = response.headers.get('X-Chat-Id')
      if (chatIdHeader && dbChatIdRef.current === undefined) {
        const newChatId = Number.parseInt(chatIdHeader, 10)
        if (!Number.isNaN(newChatId) && newChatId > 0) {
          dbChatIdRef.current = newChatId
          setTabChatId(chatId, newChatId)
        }
      }
      // Both the send POST and the live-attach GET carry the turn they belong to.
      // Recording it here — one place, whichever request got us the stream — is
      // what makes "is this presence event my own turn?" answerable by identity
      // instead of by guessing from status.
      const turnIdHeader = response.headers.get('X-Turn-Id')
      if (turnIdHeader) handledTurnRef.current = turnIdHeader
      return response
    },
    // Point the SDK's reconnect at the node's live-turn endpoint (keyed by the
    // node-assigned chat id) instead of the default `${api}/${id}/stream`, which
    // the node does not implement. Both targets use it: the node buffers every
    // turn's wire bytes, including turns *this* surface did not start, so the
    // same reconnect path covers a dropped tunnel AND attaching to a turn the
    // desktop (or the phone) kicked off. On web this resolves through the broker
    // tunnel to the same node endpoint.
    prepareReconnectToStreamRequest: async () => {
      const baseUrl = await getBaseUrl()
      return { api: `${baseUrl}/ai/chat/live/${dbChatIdRef.current}` }
    },
    prepareSendMessagesRequest: async ({ messages, body }) => {
      const baseUrl = await getBaseUrl()
      // Send only the current turn (from the last user message onward), not the
      // whole history. The server is the source of truth: it persists each turn and
      // reconstructs context itself — stateful providers (claude/codex/cursor/
      // copilot/opencode/gemini) resume by sessionId and only read the latest user
      // message; the direct-API "custom" provider rebuilds from its own dbHistory.
      // So resending the full array just wastes bandwidth (acutely over the mobile/
      // web broker tunnel). We keep messages from the last user message onward (not
      // strictly the last) so persistence still sees the user message and a
      // tool-approval continuation (assistant-last) still carries its turn.
      // NOTE: this assumes no provider needs the full transcript per turn — true
      // today (codex's full-history `stateless` threadMode is never enabled). If
      // that changes, source the transcript from dbHistory on the server instead.
      let turnStart = 0
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { turnStart = i; break }
      }
      const outboundMessages = messages
        .slice(turnStart)
        .map((message) => normalizeOutboundMessagePaths(message as UIMessage))
        .filter(Boolean) as UIMessage[]
      const currentTab = useEditorStore.getState().tabs.find((tab) => tab.id === chatId)

      return {
        api: `${baseUrl}/ai/chat`,
        body: {
          ...chatBodyRef.current,
          // Per-call body (e.g. { asGoal: true }) overrides session defaults.
          ...(body ?? {}),
          chatId: dbChatIdRef.current,
          frontendChatId: chatId,
          messages: outboundMessages,
          tp: currentTab?.isSubAgent ? 'subagent' : undefined,
        },
      }
    },
  }), [chatId, setTabChatId])

  // Web stream-resume bookkeeping (all dead-code-eliminated on desktop).
  const pendingResumeRef = useRef(false) // a turn was cut off by a network drop
  const resumingRef = useRef(false) // a resume attempt is in flight
  const resumeSettledRef = useRef(false) // onFinish fired during the current resume
  // Covers the whole attach transaction, including its optional history refresh.
  // `resumingRef` alone starts too late to dedupe two callers both refreshing
  // history before they reach resumeStream().
  const attachInFlightRef = useRef<Promise<void> | null>(null)
  const attachTargetTurnRef = useRef<string | null>(null)

  /**
   * When the turn currently on screen started, or null if none is ours to time.
   *
   * The existing events only record that a message was *sent*; nothing recorded
   * whether the agent got anywhere, which left success rate and turn duration
   * unanswerable. A turn we did not start (a resumed one, on a surface that
   * joined mid-stream) stays null so it cannot report a fabricated duration.
   */
  const turnStartedAtRef = useRef<number | null>(null)

  const trackTurnFinished = useCallback(
    (outcome: 'completed' | 'disconnected' | 'error' | 'stopped') => {
      const startedAt = turnStartedAtRef.current
      if (startedAt === null) return
      turnStartedAtRef.current = null
      trackEvent('agent_turn_finished', {
        outcome,
        provider_id: providerId,
        duration_ms: Math.round(performance.now() - startedAt),
      })
    },
    [providerId]
  )

  const {
    messages,
    status,
    error: chatError,
    sendMessage,
    stop: rawStop,
    setMessages,
    resumeStream,
    addToolApprovalResponse,
  } = useChat({
    id: chatId,
    transport,
    experimental_throttle: 50,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (error) => {
      console.error('Chat error:', error)
      trackTurnFinished('error')
      // A mid-turn stream drop can surface here (fetch "Load failed") while the tab
      // is still foreground + online — the wake-based resume never fires in that
      // case. Mark the turn resumable so both the wake handler and the foreground
      // effect below can rejoin it instead of parking the error on screen.
      if (IS_WEB && isNetworkError(error)) pendingResumeRef.current = true
    },
    onFinish: ({ isDisconnect }) => {
      trackTurnFinished(isDisconnect ? 'disconnected' : 'completed')
      // A network drop (not a user stop, not a clean finish) leaves the turn running
      // on the node; mark it so we resume when connectivity returns.
      if (IS_WEB && isDisconnect) pendingResumeRef.current = true
      resumeSettledRef.current = true
    },
  })

  // Start the clock when a turn we own begins. `submitted` is the first status
  // after send; a turn joined mid-stream never passes through it.
  useEffect(() => {
    if (status === 'submitted' && turnStartedAtRef.current === null) {
      turnStartedAtRef.current = performance.now()
    }
  }, [status])

  const statusRef = useRef(status)
  statusRef.current = status
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // The ONLY thing that should kill the node's generation is a deliberate Stop.
  // The node no longer ties a turn's life to the request that started it (other
  // surfaces attach to the same live stream, and the requester itself can
  // re-attach), so a real stop must be signalled out-of-band. Everything else —
  // unmounting the panel (mobile back / tab switch), a network blip,
  // backgrounding, closing the window that sent the message — leaves the turn
  // running so it can be resumed or simply finishes on its own.
  const stop = useCallback(() => {
    trackTurnFinished('stopped')
    const id = dbChatIdRef.current
    if (id !== undefined) {
      void api.aiAbort(id).catch(() => {})
      if (IS_WEB) {
        // Also drop the broker's resume buffer for this turn, so a stale replay
        // can't resurrect a stream the user just stopped.
        void getBaseUrl().then((baseUrl) => {
          fetch(`${baseUrl}/ai/chat/cancel/${id}`, { method: 'POST', keepalive: true }).catch(() => {})
        })
      }
    }
    return rawStop()
  }, [rawStop, trackTurnFinished]) // dbChatIdRef is a stable ref

  // Rejoin a turn — one this surface lost to a network drop, or one another
  // surface started. The SDK's resume replays the node's buffered stream from the
  // start; because UIMessageChunks reconcile by id, a full replay is safe — BUT
  // only against a fresh assistant slot. A transient reconnect still holds the
  // partial assistant message in memory, and the SDK would append the replayed
  // parts onto it (text-start always pushes a new part), doubling the content. So
  // drop the trailing in-progress assistant message first, then resume; the replay
  // rebuilds it cleanly. If the buffer is already gone the resume yields nothing
  // (204) and we restore the persisted message from chat history.
  const reloadHistoryFromServer = useCallback(async () => {
    const id = dbChatIdRef.current
    if (id === undefined) return
    try {
      const result = await api.chatHistoryGet(id, { limit: TAIL_SYNC_SIZE })
      const normalized = await normalizeHistoryMessages(result?.messages ?? [])
      // Merged rather than assigned: this runs on every reconnect, and reconnects
      // are routine on mobile (backgrounding, screen lock, network switches).
      // Assigning the page dropped whatever older messages the user had scrolled
      // up to load, which read as the app silently losing history.
      setMessages((current) => mergeServerTail(current, normalized))
    } catch (err) {
      console.error('[resume] history fallback failed:', err)
    }
  }, [setMessages]) // dbChatIdRef is a stable ref

  const runResume = useCallback(async () => {
    if (resumingRef.current) return
    if (dbChatIdRef.current === undefined) return
    if (statusRef.current === 'submitted' || statusRef.current === 'streaming') return
    resumingRef.current = true
    pendingResumeRef.current = false // this attempt consumes the pending flag
    try {
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        return last?.role === 'assistant' ? prev.slice(0, -1) : prev
      })
      resumeSettledRef.current = false
      await resumeStream()
      // onFinish flips resumeSettledRef when a stream was actually processed; if it
      // never fired the resume was a 204 (buffer expired) → fall back to history.
      if (!resumeSettledRef.current) {
        await reloadHistoryFromServer()
      }
    } catch (err) {
      console.error('[resume] failed:', err)
    } finally {
      resumingRef.current = false
    }
  }, [resumeStream, setMessages, reloadHistoryFromServer]) // refs are stable

  // Came back online / to the foreground: resume the turn THIS live instance saw
  // drop (pendingResumeRef was set by onFinish's isDisconnect).
  useEffect(() => {
    if (!IS_WEB) return
    const onWake = () => {
      if (document.visibilityState === 'hidden') return
      if (!pendingResumeRef.current) return
      pendingResumeRef.current = false
      void runResume()
    }
    window.addEventListener('online', onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      window.removeEventListener('online', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [runResume])

  // Web safety net: a mid-turn drop can land as an error while the tab is still
  // foreground + online — the wake handler above never fires then. Do ONE in-place
  // resume so a transient tunnel/broker blip recovers silently instead of leaving
  // "Load failed" on screen. Bounded to a single attempt per error episode (the
  // ref re-arms once status leaves 'error'); a non-network error is left visible.
  const foregroundResumedRef = useRef(false)
  useEffect(() => {
    if (!IS_WEB) return
    if (status !== 'error') {
      foregroundResumedRef.current = false
      return
    }
    if (foregroundResumedRef.current) return
    if (dbChatIdRef.current === undefined) return
    if (!isNetworkError(chatError)) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    foregroundResumedRef.current = true
    const timer = setTimeout(() => { void runResume() }, 600)
    return () => clearTimeout(timer)
  }, [status, chatError, runResume])

  // One coordinator for both attach triggers:
  //   1. the initial persisted-history check after opening a chat;
  //   2. a live-status event for a turn another surface just started.
  //
  // The first caller owns the whole history-refresh + resume transaction. A
  // second caller reuses it, while a genuinely newer turn is parked for the
  // status-settled effect below.
  const ensureLiveTurnAttached = useCallback(({
    turnId,
    refreshHistory = false,
  }: {
    turnId?: string
    refreshHistory?: boolean
  } = {}): Promise<void> => {
    if (turnId && handledTurnRef.current === turnId) return Promise.resolve()

    const inFlight = attachInFlightRef.current
    if (inFlight) {
      if (
        turnId &&
        turnId !== attachTargetTurnRef.current &&
        turnId !== handledTurnRef.current
      ) {
        pendingTurnRef.current = turnId
      }
      return inFlight
    }

    attachTargetTurnRef.current = turnId ?? null
    const task = (async () => {
      if (refreshHistory) await reloadHistoryFromServer()
      await runResume()
    })()
    const clearTask = (): void => {
      if (attachInFlightRef.current !== task) return
      attachInFlightRef.current = null
      attachTargetTurnRef.current = null
    }
    attachInFlightRef.current = task
    void task.then(clearTask, clearTask)
    return task
  }, [reloadHistoryFromServer, runResume])

  // ChatPanel calls this after the initial history request settles. If presence
  // arrived first, consume the parked turn without fetching history again;
  // otherwise the persisted trailing user message is the fallback evidence that
  // a reply may still be live.
  const resumeOnAttach = useCallback(() => {
    historyReadyRef.current = true
    const pendingTurn = pendingTurnRef.current
    if (pendingTurn !== null) {
      pendingTurnRef.current = null
      // A failed initial history request also marks historyLoaded=true. Retry it
      // only when it produced no messages; the normal successful path reuses the
      // page already loaded by useChatHistory.
      void ensureLiveTurnAttached({
        turnId: pendingTurn,
        refreshHistory: messagesRef.current.length === 0,
      })
      return
    }

    const msgs = messagesRef.current
    if (msgs[msgs.length - 1]?.role !== 'user') return
    void ensureLiveTurnAttached()
  }, [ensureLiveTurnAttached]) // refs are stable

  // Held in a ref so the subscription below depends only on the chat id. A
  // stream that re-subscribes on every render would reconnect on each token.
  const ensureLiveTurnAttachedRef = useRef(ensureLiveTurnAttached)
  ensureLiveTurnAttachedRef.current = ensureLiveTurnAttached

  useEffect(() => {
    const id = dbChatId
    if (id === undefined || id <= 0) return
    setLiveTurnActive(null)
    // Presence for every chat arrives on ONE shared stream — this used to open an
    // SSE connection per conversation, and those are what exhausted the
    // renderer's 6-socket-per-origin budget. See `lib/live-turn-events.ts`.
    const unsubscribe = subscribeChatPresence(id, {
      onStatus: (event) => {
        // The node's own view of this chat, snapshot on connect and updated on
        // every turn start/end. Recorded before the attach logic below bails out,
        // which it does for turns this surface already holds.
        setLiveTurnActive(event.active === true)
        if (!event.active || !event.turnId) return
        // We already hold this turn's stream: either our own POST opened it, or
        // we attached to it earlier. Attaching again would duplicate it.
        if (handledTurnRef.current === event.turnId) return
        if (!historyReadyRef.current) {
          // The initial history request already in flight contains the peer's
          // persisted user message. Let resumeOnAttach consume this turn once
          // that request settles instead of issuing the same history GET again.
          pendingTurnRef.current = event.turnId
          return
        }
        if (statusRef.current === 'submitted' || statusRef.current === 'streaming') {
          // Mid-stream, and this turn isn't one we've seen a response header for.
          // Either our own POST's headers haven't landed yet (the presence frame
          // and the response race), or a peer's new turn just preempted ours —
          // the node aborts the running request when a second one arrives, and
          // our status won't reflect that for another moment. Can't tell yet, and
          // dropping it is unrecoverable: presence fires once per turn start, so
          // a preempted surface would sit on its truncated reply forever. Park it
          // and decide once our own stream settles.
          pendingTurnRef.current = event.turnId
          return
        }
        void ensureLiveTurnAttachedRef.current({
          turnId: event.turnId,
          refreshHistory: true,
        })
      },
      // Presence never answered (offline, tunnel down): report "no live turn" so
      // consumers fall back to local status instead of waiting forever. A drop
      // *after* an answer keeps it — losing the connection mid-turn is not
      // evidence the turn ended, and the shared stream reconnects with the truth.
      onError: () => setLiveTurnActive((prev) => (prev === null ? false : prev)),
    })
    return unsubscribe
  }, [dbChatId]) // refs are stable

  // Settle a parked turn. By now our own stream has ended, so the ambiguity above
  // is resolved: if the parked id is what our POST returned it was ours all along
  // and there is nothing to do; otherwise a peer really did take the chat over and
  // this is the only chance to join them.
  useEffect(() => {
    if (status === 'submitted' || status === 'streaming') return
    if (!historyReadyRef.current) return
    const pending = pendingTurnRef.current
    if (pending === null) return
    pendingTurnRef.current = null
    if (handledTurnRef.current === pending) return
    void ensureLiveTurnAttachedRef.current({
      turnId: pending,
      refreshHistory: true,
    })
  }, [status]) // refs are stable

  const isGenerating = status === 'submitted' || status === 'streaming'
  const lastMessage = messages[messages.length - 1]
  const lastMessageId = lastMessage?.id
  const lastMessageTextSize = getMessageTextSize(lastMessage)
  const hasStepStarted = status === 'streaming' &&
    lastMessage?.role === 'assistant' &&
    lastMessage.parts?.some((part) => part.type === 'step-start')
  // Driven by the provider's declared capability rather than a hardcoded id: every
  // provider implementing `dynamicSet` can take a model/mode change mid-turn, and
  // the engine applies it at the next turn boundary.
  const canDynamicSwitch = hasStepStarted && supportsDynamicSwitch === true

  return {
    historyDbChatId,
    dbChatIdRef,
    chatBodyRef,
    messages,
    status,
    chatError,
    sendMessage,
    stop,
    setMessages,
    addToolApprovalResponse,
    resumeOnAttach,
    liveTurnActive,
    isGenerating,
    lastMessage,
    lastMessageId,
    lastMessageTextSize,
    hasStepStarted,
    canDynamicSwitch,
    selectedModelId,
  }
}
