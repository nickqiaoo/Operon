import { useQuery } from '@tanstack/react-query'
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

const NO_MESSAGES: PreviewMessage[] = []

export function useChatPreviewPolling(chatId: number | null, options: {
  enabled: boolean
  interval: number // 0 = no polling
}) {
  const enabled = options.enabled && !!chatId
  // Keyed by chat, so switching the previewed node never flashes the previous
  // chat's messages. Asking for a `limit` keeps the route out of full mode
  // (every message, tool outputs included) — only the text tail is rendered.
  const { data } = useQuery({
    queryKey: ['chat-preview', chatId, PREVIEW_MESSAGE_LIMIT] as const,
    queryFn: async () => {
      const entry = await api.chatHistoryGet(chatId!, { limit: PREVIEW_MESSAGE_LIMIT })
      return entry?.messages ? extractMessages(entry.messages as unknown[]) : NO_MESSAGES
    },
    enabled,
    refetchInterval: options.interval > 0 ? options.interval : false,
  })

  return { messages: enabled ? data ?? NO_MESSAGES : NO_MESSAGES }
}
