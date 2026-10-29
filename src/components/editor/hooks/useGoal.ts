import { useCallback, useEffect, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { CodexGoal } from '@/types/goal'

/** Undefined means no update; null is an explicit goal/cleared snapshot. */
export function goalFromLastAssistant(messages: UIMessage[], fromIndex: number): CodexGoal | null | undefined {
  for (let i = messages.length - 1; i >= fromIndex; i -= 1) {
    if (messages[i].role !== 'assistant') continue
    const metadata = messages[i].metadata as { goal?: CodexGoal | null } | undefined
    if (metadata && 'goal' in metadata) return metadata.goal
  }
  return undefined
}

interface UseGoalArgs {
  dbChatId?: number
  messages: UIMessage[]
  supported: boolean
  isGenerating: boolean
  sendGoalMessage: (objective: string) => Promise<void>
  stop: () => void
}

export function useGoal({ dbChatId, messages, supported, isGenerating, sendGoalMessage, stop }: UseGoalArgs) {
  const [goal, setGoal] = useState<CodexGoal | null>(null)
  const [pending, setPending] = useState(false)
  const goalRef = useRef(goal)
  goalRef.current = goal
  const chatRef = useRef(dbChatId)
  chatRef.current = dbChatId
  const previousChatRef = useRef(dbChatId)
  const messagesLenRef = useRef(messages.length)
  messagesLenRef.current = messages.length
  const pursuitStartIndexRef = useRef(0)
  const controlPendingRef = useRef(false)
  const revisionRef = useRef(0)
  const wasGeneratingRef = useRef(isGenerating)

  // Rehydrate on opening a chat and reconcile when a stream settles, including
  // failures. In-flight reads must not overwrite newer streamed/user updates.
  useEffect(() => {
    const previous = previousChatRef.current
    previousChatRef.current = dbChatId
    const justPersisted = previous === undefined && dbChatId !== undefined && goalRef.current !== null
    if (previous !== dbChatId && !justPersisted) {
      setGoal(null)
      pursuitStartIndexRef.current = messagesLenRef.current
      revisionRef.current += 1
    }
    if (!supported) { setGoal(null); return }
    if (!dbChatId || isGenerating) return
    let cancelled = false
    const revision = revisionRef.current
    void api.aiGetGoal(dbChatId).then((res) => {
      if (cancelled || !res.success || revision !== revisionRef.current || controlPendingRef.current) return
      setGoal(res.goal ?? null)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [dbChatId, supported, isGenerating])

  // Also consume the final metadata flush after isGenerating becomes false.
  useEffect(() => {
    const wasGenerating = wasGeneratingRef.current
    wasGeneratingRef.current = isGenerating
    if (!isGenerating && !wasGenerating) {
      pursuitStartIndexRef.current = messages.length
      return
    }
    if (!supported || controlPendingRef.current) return
    const latest = goalFromLastAssistant(messages, pursuitStartIndexRef.current)
    if (latest === undefined) return
    revisionRef.current += 1
    setGoal(latest)
  }, [messages, supported, isGenerating])

  const startGoal = useCallback((objective: string) => {
    const trimmed = objective.trim()
    if (!trimmed || !supported || isGenerating || controlPendingRef.current) return false
    if (trimmed.length > 4000) {
      toast.error('Keep the goal within 4,000 characters.')
      return false
    }
    revisionRef.current += 1
    pursuitStartIndexRef.current = messagesLenRef.current
    setGoal({ objective: trimmed, status: 'active' })
    const chatId = dbChatId
    void sendGoalMessage(trimmed).catch((error: unknown) => {
      if (chatRef.current !== chatId && chatId !== undefined) return
      setGoal((current) => current ? { ...current, status: 'paused' } : null)
      toast.error(error instanceof Error ? error.message : 'Could not start the goal. Try again.')
    })
    return true
  }, [dbChatId, isGenerating, sendGoalMessage, supported])

  const controlGoal = useCallback(async (action: 'pause' | 'clear') => {
    if (!dbChatId || controlPendingRef.current) return
    controlPendingRef.current = true
    setPending(true)
    revisionRef.current += 1
    try {
      const result: { success: boolean; error?: string; goal?: CodexGoal | null } = action === 'clear'
        ? await api.aiClearGoal(dbChatId)
        : await api.aiSetGoalStatus(dbChatId, 'paused')
      if (!result.success) throw new Error(result.error || 'Could not update the goal. Try again.')
      if (chatRef.current !== dbChatId) return
      // Ignore the old stream's last active snapshot after this user action.
      pursuitStartIndexRef.current = messagesLenRef.current
      setGoal(action === 'clear' ? null : result.goal ?? null)
      stop()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the goal. Try again.')
    } finally {
      controlPendingRef.current = false
      setPending(false)
    }
  }, [dbChatId, stop])

  const clearGoal = useCallback(() => { void controlGoal('clear') }, [controlGoal])
  const pauseGoal = useCallback(() => { void controlGoal('pause') }, [controlGoal])
  const resumeGoal = useCallback(() => {
    if (goalRef.current) startGoal(goalRef.current.objective)
  }, [startGoal])

  return { goal, pending, goalActive: goal != null, startGoal, clearGoal, pauseGoal, resumeGoal }
}
