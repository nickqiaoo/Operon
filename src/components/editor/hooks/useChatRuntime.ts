import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai'
import { useChat } from '@ai-sdk/react'
import { useChatApi, useChatTransport } from '@/lib/chat-api-context'
import { subscribeChatTurnStatus, type ChatTurnStatus } from '@/lib/chat-status-events'
import { useEditorStore } from '@/stores/editor-store'
import { normalizeOutboundMessagePaths } from '../utils/chatMetadata'
import { mergeServerTail, TAIL_SYNC_SIZE } from '../utils/merge-server-tail'
import { normalizeHistoryMessages } from './useChatHistory'
import { trackEvent } from '@/lib/analytics'
import { turnSettingsSaved } from '@/lib/turn-settings-saves'

/** Upper bound on how long a Stop may hold back transcript reconciliation. */
const ABORT_SETTLE_TIMEOUT_MS = 8000

/** Backoff for resuming a stream a network drop cut off (one entry per attempt). */
const RESUME_RETRY_DELAYS_MS = [600, 2000, 5000]

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

/** A network drop we wait out rather than retry into: offline or in the background. */
const unreachable = (): boolean =>
  (typeof navigator !== 'undefined' && navigator.onLine === false) ||
  (typeof document !== 'undefined' && document.visibilityState === 'hidden')

/**
 * Before a turn's reply is rebuilt from its stream: drop an older copy of it that is not
 * the last message (a steer sent after it). The SDK replaces the reply in place
 * only when it is last; anywhere else it would be shown twice.
 */
const withoutStaleCopy = (messages: UIMessage[], messageId: string): UIMessage[] => {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index === -1 || index === messages.length - 1) return messages
  return messages.filter((message) => message.id !== messageId)
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
  draftSshEnvironmentId,
  draftAdditionalSshEnvironmentIds,
  draftLocalDir,
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
  draftLocalDir?: string
  draftAdditionalSshEnvironmentIds?: string[]
  draftSshEnvironmentId?: string
  autoRun?: boolean
  setTabChatId: (tabId: string, chatId: number) => void
}) {
  const api = useChatApi()
  // The machine this tab's chat lives on: stream, reconnect and cancel go there too.
  const backend = useChatTransport()
  const nodeId = backend.nodeId
  const [historyDbChatId, setHistoryDbChatId] = useState(dbChatId)
  const dbChatIdRef = useRef<number | undefined>(dbChatId)
  const chatBodyRef = useRef<Record<string, unknown>>({})

  // Turn bookkeeping, used by the attach rule further down.
  /** The turn whose stream this surface holds, from X-Turn-Id on the POST or GET that brought it. */
  const heldTurnRef = useRef<string | null>(null)
  /** The last turn the status stream announced that this surface tried to attach to (one try each). */
  const triedTurnRef = useRef<string | null>(null)
  /** The stream this surface held was cut off before the turn ended. */
  const lostTurnRef = useRef(false)
  /** The latest turn status the node reported for this chat. */
  const turnStatusRef = useRef<ChatTurnStatus | null>(null)
  /** Initial history has settled; attaching earlier would let that page land on the streamed reply. */
  const historyReadyRef = useRef(false)
  /** The page just loaded is current, so the first attach need not fetch it again. */
  const historyFreshRef = useRef(false)
  /** The last turn-stream GET answered 204: nothing is running. */
  const emptyAttachRef = useRef(false)
  /** `setMessages`, for the transport (built before `useChat` returns it). */
  const setMessagesRef = useRef<((update: (messages: UIMessage[]) => UIMessage[]) => void) | null>(null)

  /**
   * Does the *node* have a turn running for this chat? `null` until the status stream
   * answers.
   *
   * Local `status` cannot answer this after a remount: `useChat` starts fresh at
   * 'ready' and only flips to 'streaming' once resume has reattached, so a chat
   * reopened mid-turn looks finished for a moment. Anything that keys off "the
   * turn is over" has to wait for this instead.
   */
  const [nodeTurnActive, setNodeTurnActive] = useState<boolean | null>(null)

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
  // follows, `onHistoryLoaded` is never called again, and this stayed false
  // forever — ignoring every turn the node started (a delivered workflow
  // result, a peer window's turn) instead of attaching to it.
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
  const localDirRef = useRef(draftLocalDir)
  localDirRef.current = draftLocalDir
  const additionalIdsRef = useRef(draftAdditionalSshEnvironmentIds)
  additionalIdsRef.current = draftAdditionalSshEnvironmentIds
  const draftSshEnvironmentIdRef = useRef(draftSshEnvironmentId)
  draftSshEnvironmentIdRef.current = draftSshEnvironmentId

  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/ai/chat',
    fetch: async (input, init) => {
      // Desktop target talks to the local server directly and must present the
      // startup token; on web these headers are empty (the tunnel agent stamps
      // the token on the desktop side).
      const headers = new Headers(init?.headers)
      for (const [key, value] of Object.entries(backend.authHeaders())) headers.set(key, value)
      const response = await fetch(input, { ...init, headers })
      const chatIdHeader = response.headers.get('X-Chat-Id')
      if (chatIdHeader && dbChatIdRef.current === undefined) {
        const newChatId = Number.parseInt(chatIdHeader, 10)
        if (!Number.isNaN(newChatId) && newChatId > 0) {
          dbChatIdRef.current = newChatId
          setTabChatId(chatId, newChatId)
        }
      }
      // Both the send POST and the turn-stream GET carry the turn they belong to.
      // Recording it here — one place, whichever request got us the stream — is
      // what makes "is this announced turn my own?" answerable by identity
      // instead of by guessing from status.
      const turnIdHeader = response.headers.get('X-Turn-Id')
      if (turnIdHeader) heldTurnRef.current = turnIdHeader
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/ai/chat/stream/')) {
        if (response.status === 204) emptyAttachRef.current = true
        const messageId = response.headers.get('X-Message-Id')
        if (response.ok && messageId) setMessagesRef.current?.((messages) => withoutStaleCopy(messages, messageId))
      }
      return response
    },
    // Point the SDK's reconnect at the node's turn-stream endpoint (keyed by the
    // node-assigned chat id) instead of the default `${api}/${id}/stream`, which
    // the node does not implement. The node serves every turn there, including
    // turns *this* surface did not start, so the same path covers a dropped
    // tunnel AND attaching to a turn the desktop (or the phone) kicked off. On
    // web this resolves through the broker tunnel to the same node endpoint.
    prepareReconnectToStreamRequest: async () => {
      const baseUrl = await backend.baseUrl()
      return { api: `${baseUrl}/ai/chat/stream/${dbChatIdRef.current}` }
    },
    prepareSendMessagesRequest: async ({ messages, body }) => {
      // A model / mode pick made just before sending is saved on the server
      // first: an agent's chat runs on what is saved there.
      if (dbChatIdRef.current !== undefined) await turnSettingsSaved({ nodeId: backend.nodeId, chatId: dbChatIdRef.current })
      const sshEnvironmentId = dbChatIdRef.current === undefined ? draftSshEnvironmentIdRef.current : undefined
      const baseUrl = await backend.baseUrl()
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
          sshEnvironmentId,
          localEnvironmentCwd: dbChatIdRef.current === undefined ? localDirRef.current : undefined,
          additionalSshEnvironmentIds: dbChatIdRef.current === undefined ? additionalIdsRef.current : undefined,
          frontendChatId: chatId,
          messages: outboundMessages,
          tp: currentTab?.isSubAgent ? 'subagent' : undefined,
        },
      }
    },
  }), [chatId, setTabChatId, backend])

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
    throttle: 50,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (error) => {
      console.error('Chat error:', error)
      trackTurnFinished('error')
      // A dropped connection (fetch "Load failed" and friends) is not the turn
      // failing: it keeps running on the node, so this surface rejoins it.
      if (isNetworkError(error)) {
        lostTurnRef.current = true
        heldTurnRef.current = null
      }
    },
    onFinish: ({ isDisconnect }) => {
      trackTurnFinished(isDisconnect ? 'disconnected' : 'completed')
      if (isDisconnect) {
        lostTurnRef.current = true
        heldTurnRef.current = null
      }
    },
  })
  setMessagesRef.current = setMessages

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

  /** True from a Stop click until the node confirms the turn is fully persisted. */
  const [turnSettling, setTurnSettling] = useState(false)

  // The ONLY thing that should kill the node's generation is a deliberate Stop.
  // The node no longer ties a turn's life to the request that started it (other
  // surfaces attach to the same turn stream, and the requester itself can
  // re-attach), so a real stop must be signalled out-of-band. Everything else —
  // unmounting the panel (mobile back / tab switch), a network blip,
  // backgrounding, closing the window that sent the message — leaves the turn
  // running so it can be resumed or simply finishes on its own.
  const stop = useCallback(() => {
    trackTurnFinished('stopped')
    const id = dbChatIdRef.current
    if (id !== undefined) {
      // Stop cuts the local stream the instant it is clicked, but the node still
      // has to wind the turn down and write the partial reply. Until that write
      // lands, chat history is BEHIND what is on screen, so anything that
      // reconciles the transcript against the server in that window deletes the
      // reply the user just watched stream in (the steer sync in ChatPanel did
      // exactly that). `/ai/abort` only answers once the write has landed, so
      // awaiting it is what gives the flag its meaning; the timeout is a floor
      // under a request that never comes back (dropped tunnel), so the sync is
      // delayed rather than disabled for the rest of the chat.
      setTurnSettling(true)
      void Promise.race([
        api.aiAbort(id).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, ABORT_SETTLE_TIMEOUT_MS)),
      ]).finally(() => setTurnSettling(false))
    }
    return rawStop()
  }, [rawStop, trackTurnFinished]) // dbChatIdRef is a stable ref

  // ---- Following the chat's turn on the node ----
  //
  // The node runs every turn whoever is watching, and serves it to any surface
  // from GET /ai/chat/stream/:chatId: the reply as it stands, then the rest, on
  // one response. So this surface only decides WHEN to attach, by one rule that
  // covers every case — a turn a peer (or the node itself) started, our own
  // stream cut by a network drop, a chat reopened mid-turn:
  //
  //   attach once history is loaded and no stream is in flight here, when the
  //   node reports a turn this surface does not hold, or the stream this
  //   surface held was lost.
  //
  // Attaching is the same each time: refresh the history tail when the turn
  // may have brought messages this surface never saw (a peer's prompt), then
  // resume. The SDK replaces the reply it already shows (same message id); a
  // 204 means the turn is over and history has the reply.

  const reloadHistoryFromServer = useCallback(async () => {
    const id = dbChatIdRef.current
    if (id === undefined) return
    try {
      const result = await api.chatHistoryGet(id, { limit: TAIL_SYNC_SIZE })
      const normalized = await normalizeHistoryMessages(result?.messages ?? [], api)
      // Merged rather than assigned: this runs on every reconnect, and reconnects
      // are routine on mobile (backgrounding, screen lock, network switches).
      // Assigning the page dropped whatever older messages the user had scrolled
      // up to load, which read as the app silently losing history.
      setMessages((current) => mergeServerTail(current, normalized))
    } catch (err) {
      console.error('[chat-turn] history refresh failed:', err)
    }
  }, [setMessages]) // dbChatIdRef is a stable ref

  const attachingRef = useRef(false)
  const attach = useCallback(async ({ refreshHistory }: { refreshHistory: boolean }) => {
    if (attachingRef.current || dbChatIdRef.current === undefined) return
    attachingRef.current = true
    lostTurnRef.current = false
    emptyAttachRef.current = false
    try {
      if (refreshHistory) await reloadHistoryFromServer()
      await resumeStream()
      // Nothing running: the turn ended while we were away, and its reply is saved.
      if (emptyAttachRef.current && !refreshHistory) await reloadHistoryFromServer()
    } catch (err) {
      console.error('[chat-turn] attach failed:', err)
    } finally {
      attachingRef.current = false
    }
    // The node may have moved on while we attached (a newer turn started).
    reconcileRef.current()
  }, [resumeStream, reloadHistoryFromServer]) // refs are stable

  /** Apply the rule above to where things stand now. Safe to call any time. */
  const reconcile = useCallback(() => {
    if (!historyReadyRef.current || attachingRef.current) return
    if (dbChatIdRef.current === undefined) return
    const current = statusRef.current
    if (current === 'submitted' || current === 'streaming') return // decided once our stream settles
    // A dropped stream still on screen as an error retries on its own schedule (below).
    if (current === 'error' && lostTurnRef.current) return

    const turnStatus = turnStatusRef.current
    const nodeTurnId = turnStatus?.active ? turnStatus.turnId : null
    if (nodeTurnId && nodeTurnId !== heldTurnRef.current && nodeTurnId !== triedTurnRef.current) {
      triedTurnRef.current = nodeTurnId // one try per turn: a 204 must not loop
      void attach({ refreshHistory: !historyFreshRef.current })
      historyFreshRef.current = false
      return
    }
    if (lostTurnRef.current && !unreachable()) void attach({ refreshHistory: false })
  }, [attach]) // refs are stable
  const reconcileRef = useRef(reconcile)
  reconcileRef.current = reconcile

  // Our own stream settling is when a turn noticed meanwhile can be decided.
  useEffect(() => {
    reconcileRef.current()
  }, [status])

  /**
   * ChatPanel calls this once the initial history request settles: attaching
   * before it would let that page land on top of the streamed reply.
   */
  const onHistoryLoaded = useCallback(() => {
    historyReadyRef.current = true
    // A page that failed to load is no reason to skip refreshing before attach.
    historyFreshRef.current = messagesRef.current.length > 0 && turnStatusRef.current?.active === true
    // The transcript ends on a prompt with no reply: a turn may be running that
    // the status stream has not reported yet. Asking costs one request (204 if not).
    if (messagesRef.current.at(-1)?.role === 'user') lostTurnRef.current = true
    reconcileRef.current()
  }, []) // refs are stable

  useEffect(() => {
    const id = dbChatId
    if (id === undefined || id <= 0) return
    setNodeTurnActive(null)
    turnStatusRef.current = null
    // Every chat's status arrives on ONE shared stream — this used to open an
    // SSE connection per conversation, and those are what exhausted the
    // renderer's 6-socket-per-origin budget. See `lib/chat-status-events.ts`.
    const unsubscribe = subscribeChatTurnStatus(nodeId ? { nodeId, chatId: id } : { chatId: id }, {
      onStatus: (event) => {
        turnStatusRef.current = event
        setNodeTurnActive(event.active === true)
        reconcileRef.current()
      },
      // The status stream never answered (offline, tunnel down): report "no turn" so
      // consumers fall back to local status instead of waiting forever. A drop
      // *after* an answer keeps it — losing the connection mid-turn is not
      // evidence the turn ended, and the shared stream reconnects with the truth.
      onError: () => setNodeTurnActive((prev) => (prev === null ? false : prev)),
    })
    return unsubscribe
  }, [dbChatId]) // refs are stable

  // A dropped stream shows as a network error. Retry with a short backoff (the
  // network is often not usable in the first second after a wake), bounded per
  // drop; offline or backgrounded, wait for the wake below instead. While these
  // attempts are pending the panel shows "Reconnecting…" rather than the raw
  // fetch message; a non-network error is left on screen.
  const resumeAttemptsRef = useRef(0)
  /** The error whose automatic attempts are all used up. */
  const [reconnectGaveUpOn, setReconnectGaveUpOn] = useState<Error | null>(null)
  const networkDropped = status === 'error' && dbChatId !== undefined && isNetworkError(chatError)
  useEffect(() => {
    if (!networkDropped) {
      resumeAttemptsRef.current = 0
      return
    }
    if (unreachable()) return
    const attempt = resumeAttemptsRef.current
    if (attempt >= RESUME_RETRY_DELAYS_MS.length) {
      setReconnectGaveUpOn(chatError ?? null)
      return
    }
    // Counted when the attempt actually runs, so a re-render that clears the
    // timer doesn't burn an attempt that never happened.
    const timer = setTimeout(() => {
      resumeAttemptsRef.current = attempt + 1
      void attach({ refreshHistory: false })
    }, RESUME_RETRY_DELAYS_MS[attempt])
    return () => clearTimeout(timer)
  }, [networkDropped, chatError, attach])

  // Back online / in front again: pick a lost stream up now.
  useEffect(() => {
    const onWake = () => {
      if (unreachable() || !lostTurnRef.current) return
      resumeAttemptsRef.current = 0
      if (statusRef.current === 'error') void attach({ refreshHistory: false })
      else reconcileRef.current()
    }
    window.addEventListener('online', onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      window.removeEventListener('online', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [attach])

  /** A network drop we are still trying to recover from. */
  const reconnecting = networkDropped && reconnectGaveUpOn !== chatError
  /** A network drop the automatic attempts could not recover; offer a manual retry. */
  const reconnectFailed = networkDropped && reconnectGaveUpOn === chatError

  /** Manual retry after the automatic attempts gave up. */
  const retryReconnect = useCallback(() => {
    resumeAttemptsRef.current = 0
    setReconnectGaveUpOn(null)
    void attach({ refreshHistory: false })
  }, [attach])

  const isGenerating = status === 'submitted' || status === 'streaming'
  const lastMessage = messages[messages.length - 1]
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
    reconnecting,
    reconnectFailed,
    retryReconnect,
    sendMessage,
    stop,
    setMessages,
    addToolApprovalResponse,
    onHistoryLoaded,
    nodeTurnActive,
    isGenerating,
    turnSettling,
    lastMessage,
    hasStepStarted,
    canDynamicSwitch,
    selectedModelId,
  }
}
