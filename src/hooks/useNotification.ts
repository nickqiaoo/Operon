import { useEffect, useRef } from 'react'
import { useNotificationStore } from '@/stores/notification-store'
import type { UIMessage } from 'ai'

type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'

async function sendNotification(title: string, body: string) {
  try {
    const focused = await window.electronAPI?.isWindowFocused()
    if (focused) return
    await window.electronAPI?.showNotification({ title, body })
  } catch {
    // Notification not available (e.g. in browser dev mode)
  }
}

interface NotificationContext {
  modelLabel?: string
  providerGroup?: string
}

/**
 * Monitors chat status and messages to fire native notifications
 * when the LLM finishes responding or needs user approval.
 */
export function useChatNotifications(
  status: ChatStatus,
  messages: UIMessage[],
  context?: NotificationContext,
) {
  const enabled = useNotificationStore((s) => s.enabled)
  const notifyOnComplete = useNotificationStore((s) => s.notifyOnComplete)
  const notifyOnApproval = useNotificationStore((s) => s.notifyOnApproval)
  const prevStatusRef = useRef<ChatStatus>(status)
  const notifiedApprovalIdsRef = useRef<Set<string>>(new Set())
  const contextRef = useRef(context)
  contextRef.current = context

  // Notify when LLM response completes
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status

    if (!enabled || !notifyOnComplete) return
    if ((prev === 'streaming' || prev === 'submitted') && status === 'ready') {
      const ctx = contextRef.current
      const who = ctx?.modelLabel
        ? `${ctx.modelLabel}${ctx.providerGroup ? ` (${ctx.providerGroup})` : ''}`
        : 'AI'
      sendNotification('Response Complete', `${who} has finished its response.`)
    }
  }, [status, enabled, notifyOnComplete])

  // Notify when approval is requested
  // Include `status` in deps so the effect re-runs when streaming state changes,
  // since AI SDK may mutate part.state in-place without changing the messages reference.
  useEffect(() => {
    if (!enabled || !notifyOnApproval) return

    const lastMessage = messages[messages.length - 1]
    if (!lastMessage || lastMessage.role !== 'assistant') return

    for (const part of lastMessage.parts) {
      if (!('type' in part)) continue
      const partType = part.type as string
      // AI SDK v5: tool parts are either `dynamic-tool` or `tool-<toolName>`
      if (partType !== 'dynamic-tool' && !partType.startsWith('tool-')) continue

      const record = part as Record<string, unknown>
      const id =
        (typeof record.toolCallId === 'string' && record.toolCallId) ||
        (typeof record.toolInvocationId === 'string' && record.toolInvocationId) ||
        undefined
      if (!id) continue
      if (notifiedApprovalIdsRef.current.has(id)) continue

      const toolName =
        (typeof record.toolName === 'string' && record.toolName) ||
        (partType.startsWith('tool-') ? partType.slice(5) : 'tool')
      const state = typeof record.state === 'string' ? record.state : undefined
      const isApproval = state === 'approval-requested'
      const isQuestion = toolName === 'AskUserQuestion' || toolName === 'ask_user'
      const needsInput = isQuestion && state !== undefined && state !== 'output-available'

      if (isApproval || needsInput) {
        notifiedApprovalIdsRef.current.add(id)
        const ctx = contextRef.current
        const who = ctx?.providerGroup ?? 'AI'
        const title = isQuestion ? 'Question from Agent' : 'Approval Required'
        const body = isQuestion
          ? `${who} is asking a question.`
          : `${who}: "${toolName}" needs your permission.`
        sendNotification(title, body)
      }
    }
  }, [messages, status, enabled, notifyOnApproval])
}
