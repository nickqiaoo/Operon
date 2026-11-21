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
  tabTitle,
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
  /** The tab's current title: only the placeholder is replaced by the first message. */
  tabTitle?: string
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

  // A new chat is named after its first message. One that already has a name
  // keeps it: a board task's session is named after its task, while its first
  // message is the long dispatch prompt.
  const named = tabTitle != null && tabTitle.trim() !== '' && tabTitle !== 'Chat'
  useEffect(() => {
    if (!firstUserTitle || named) return
    updateTabTitle(chatId, firstUserTitle)
  }, [chatId, firstUserTitle, named, updateTabTitle])
}
