import { useEffect, useRef } from 'react'
import type { UIMessage } from 'ai'
import type { ExternalAgentTask } from '@/hooks/useExternalAgent'
import { useExternalAgent } from '@/hooks/useExternalAgent'
import { emitTabComplete } from '@/hooks/useExternalAgentBus'

const getAssistantText = (message: UIMessage | undefined): string => {
  if (!message) return ''

  const textParts = (message.parts ?? [])
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> =>
      part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)

  return textParts.join('\n').trim()
}

export function useChatPanelEffects({
  chatId,
  autoRun,
  input,
  timestamp,
  historyLoaded,
  isGenerating,
  messagesLength,
  sendMessage,
  setInput,
  firstUserTitle,
  updateTabTitle,
  externalAgentTasks,
  externalAgentNotificationsByTaskId,
  lastAssistant,
  currentDbChatId,
}: {
  chatId: string
  autoRun?: boolean
  input?: string
  timestamp?: number
  historyLoaded: boolean
  isGenerating: boolean
  messagesLength: number
  sendMessage: (message: { text: string }) => void
  setInput: (value: string) => void
  firstUserTitle: string | null
  updateTabTitle: (chatId: string, title: string) => void
  externalAgentTasks: ExternalAgentTask[]
  externalAgentNotificationsByTaskId: ReadonlyMap<string, { taskId: string }>
  lastAssistant?: UIMessage
  currentDbChatId?: number
}) {
  const lastAutoRunTimestampRef = useRef<number | string | undefined>(undefined)
  const emittedCompletionRef = useRef(false)

  useEffect(() => {
    if (!autoRun || !historyLoaded || isGenerating) return
    if (lastAutoRunTimestampRef.current === (timestamp ?? 'done')) return

    if (messagesLength === 0 && input) {
      lastAutoRunTimestampRef.current = timestamp ?? 'done'
      sendMessage({ text: input })
      setInput('')
    }
  }, [autoRun, historyLoaded, input, isGenerating, messagesLength, sendMessage, setInput, timestamp])

  useEffect(() => {
    if (!firstUserTitle) return
    updateTabTitle(chatId, firstUserTitle)
  }, [chatId, firstUserTitle, updateTabTitle])

  useExternalAgent({
    tasks: externalAgentTasks,
    mainChatId: chatId,
    isGenerating,
    historyLoaded,
    completedTaskIds: new Set(externalAgentNotificationsByTaskId.keys()),
    sendMessage,
  })

  useEffect(() => {
    if (!autoRun) return
    if (isGenerating || emittedCompletionRef.current || messagesLength === 0) return

    const resultText = getAssistantText(lastAssistant)
    if (!resultText) return

    emittedCompletionRef.current = true
    emitTabComplete(chatId, resultText, currentDbChatId)
  }, [autoRun, chatId, currentDbChatId, isGenerating, lastAssistant, messagesLength])
}
