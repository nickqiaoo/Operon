import { useEffect, useRef } from 'react'

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
}) {
  const lastAutoRunTimestampRef = useRef<number | string | undefined>(undefined)

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
}
