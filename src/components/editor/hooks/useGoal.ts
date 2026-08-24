import { useCallback, useEffect, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import { api } from '@/lib/api'
import { type CodexGoal, isTerminalGoalStatus } from '@/types/goal'

/**
 * Read the goal snapshot off the last assistant message of the *current*
 * pursuit. `fromIndex` is the message-count captured when this pursuit started,
 * so we never read a previous goal's leftover metadata: a completed goal leaves
 * `codexGoal: { status: 'complete' }` on its assistant message, and reading that
 * while a *new* pursuit's assistant message hasn't streamed yet would instantly
 * clear the new banner. A normal (non-goal) turn carries none, so we also never
 * resurrect a stale goal.
 */
function goalFromLastAssistant(messages: UIMessage[], fromIndex: number): CodexGoal | null {
  for (let i = messages.length - 1; i >= fromIndex; i -= 1) {
    if (messages[i].role !== 'assistant') continue
    return (messages[i].metadata as { codexGoal?: CodexGoal } | undefined)?.codexGoal ?? null
  }
  return null
}

function goalEquals(a: CodexGoal, b: CodexGoal): boolean {
  return (
    a.objective === b.objective &&
    a.status === b.status &&
    a.tokensUsed === b.tokensUsed &&
    a.timeUsedSeconds === b.timeUsedSeconds
  )
}

interface UseGoalArgs {
  /** Persisted (db) chat id — control endpoints need it; undefined for fresh chats. */
  dbChatId?: number
  /** Live messages from useChat — source of streamed goal progress. */
  messages: UIMessage[]
  /** Whether this provider exposes the goal feature. */
  supported: boolean
  /** Whether the chat is currently streaming (refine progress only then). */
  isGenerating: boolean
  /** Send the objective as a goal turn (asGoal body). */
  sendGoalMessage: (objective: string) => void
  /** Stop the active client-side stream (mirrors the Stop button). */
  stop: () => void
}

/**
 * Owns the thread-goal banner state for one chat: optimistic start, live
 * refinement from streamed `codexGoal` metadata, rehydration on load, and the
 * clear / pause / resume actions.
 */
export function useGoal({ dbChatId, messages, supported, isGenerating, sendGoalMessage, stop }: UseGoalArgs) {
  const [goal, setGoal] = useState<CodexGoal | null>(null)
  const goalActiveRef = useRef(false)
  goalActiveRef.current = goal != null
  const objectiveRef = useRef<string>('')
  if (goal?.objective) objectiveRef.current = goal.objective
  const prevDbChatIdRef = useRef<number | undefined>(dbChatId)
  // Live message count, read by the pursuit starters without re-creating their
  // callbacks. When a pursuit begins, this is the index from which the refine
  // effect is allowed to read goal metadata — everything before belongs to an
  // earlier (completed) goal and must be ignored.
  const messagesLenRef = useRef(messages.length)
  messagesLenRef.current = messages.length
  const pursuitStartIndexRef = useRef(0)

  // Rehydrate from the server when the chat changes. Crucially, a *fresh* chat
  // that just got its persisted id (undefined -> number) is NOT a chat switch:
  // it's the same tab whose first goal message returned an `X-Chat-Id`. Blowing
  // away the optimistic banner there is what made it flash and vanish. So we
  // only reset on a real switch, and we keep the locally-started goal while we
  // (best-effort) rehydrate from the server.
  useEffect(() => {
    const prev = prevDbChatIdRef.current
    prevDbChatIdRef.current = dbChatId
    const justPersisted = prev === undefined && dbChatId !== undefined && goalActiveRef.current

    if (!justPersisted) setGoal(null)
    if (!supported || !dbChatId) return
    let cancelled = false
    void api
      .aiGetGoal(dbChatId)
      .then((res) => {
        if (cancelled) return
        const g = res.success ? res.goal : null
        if (g && !isTerminalGoalStatus(g.status)) {
          // Ignore this chat's historical (completed) goal messages so they
          // can't clear the rehydrated banner.
          if (!justPersisted) pursuitStartIndexRef.current = messagesLenRef.current
          setGoal(g)
        }
        // justPersisted + empty server result: keep the optimistic banner.
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dbChatId, supported])

  // While streaming, refine the existing banner from live metadata; clear it
  // when the goal reaches a terminal status. Never creates a banner on its own,
  // and never runs when idle (so a local pause isn't overwritten by stale data).
  useEffect(() => {
    if (!goalActiveRef.current || !isGenerating) return
    const latest = goalFromLastAssistant(messages, pursuitStartIndexRef.current)
    if (!latest) return
    setGoal((prev) => {
      if (!prev) return prev
      if (latest.status === 'complete' || isTerminalGoalStatus(latest.status)) return null
      if (goalEquals(prev, latest)) return prev
      return { ...prev, ...latest }
    })
  }, [messages, isGenerating])

  const startGoal = useCallback(
    (objective: string) => {
      const trimmed = objective.trim()
      if (!trimmed) return
      objectiveRef.current = trimmed
      // Only read goal metadata from messages produced by this pursuit onward.
      pursuitStartIndexRef.current = messagesLenRef.current
      setGoal({ objective: trimmed, status: 'active' })
      sendGoalMessage(trimmed)
    },
    [sendGoalMessage],
  )

  const clearGoal = useCallback(() => {
    setGoal(null)
    stop()
    if (dbChatId) void api.aiClearGoal(dbChatId).catch(() => {})
  }, [dbChatId, stop])

  const pauseGoal = useCallback(() => {
    setGoal((prev) => (prev ? { ...prev, status: 'paused' } : prev))
    stop()
    if (dbChatId) void api.aiSetGoalStatus(dbChatId, 'paused').catch(() => {})
  }, [dbChatId, stop])

  const resumeGoal = useCallback(() => {
    const objective = objectiveRef.current
    if (!objective) return
    pursuitStartIndexRef.current = messagesLenRef.current
    setGoal((prev) => (prev ? { ...prev, status: 'active' } : { objective, status: 'active' }))
    sendGoalMessage(objective)
  }, [sendGoalMessage])

  return { goal, goalActive: goal != null, startGoal, clearGoal, pauseGoal, resumeGoal }
}
