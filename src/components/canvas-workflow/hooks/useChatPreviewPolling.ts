import { useState, useEffect } from 'react'
import { api } from '@/lib/api'

export interface PreviewMessage {
  id: string
  role: string
  content: string
}

/** The preview renders a short tail of the conversation, not its history. */
const PREVIEW_MESSAGE_LIMIT = 10

function extractMessages(raw: unknown[]): PreviewMessage[] {
  return raw.map((m) => {
    const msg = m as Record<string, unknown>
    let content = ''
    if (typeof msg.content === 'string') {
      content = msg.content
    } else if (Array.isArray(msg.parts)) {
      content = (msg.parts as Array<Record<string, unknown>>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text as string)
        .join('')
    }
    return {
      id: (msg.id as string) || String(Math.random()),
      role: (msg.role as string) || 'user',
      content,
    }
  })
}

export function useChatPreviewPolling(chatId: number | null, options: {
  enabled: boolean
  interval: number // 0 = no polling
}) {
  const [messages, setMessages] = useState<PreviewMessage[]>([])

  useEffect(() => {
    if (!options.enabled || !chatId) {
      setMessages([])
      return
    }

    // Omitting `limit` puts the route in full mode — every message in the
    // conversation, tool outputs included — on a timer. `extractMessages` then
    // keeps only the text parts, so all of that was downloaded and dropped.
    const fetchMessages = async () => {
      try {
        const entry = await api.chatHistoryGet(chatId, { limit: PREVIEW_MESSAGE_LIMIT })
        if (entry?.messages) {
          setMessages(extractMessages(entry.messages as unknown[]))
        }
      } catch {
        // Ignore fetch errors during polling
      }
    }

    // Fetch immediately
    void fetchMessages()

    // Poll if interval > 0
    if (options.interval > 0) {
      const timer = setInterval(() => void fetchMessages(), options.interval)
      return () => clearInterval(timer)
    }
  }, [chatId, options.enabled, options.interval])

  return { messages }
}
