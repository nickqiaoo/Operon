import { Eye, Loader2 } from 'lucide-react'
import { useChatPreviewPolling } from './hooks/useChatPreviewPolling'

interface ChatPreviewProps {
  chatId: number | null
  isRunning: boolean
}

export function ChatPreview({ chatId, isRunning }: ChatPreviewProps) {
  const { messages } = useChatPreviewPolling(chatId, {
    enabled: !!chatId,
    interval: isRunning ? 1000 : 0,
  })

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border/50 p-3 flex items-center gap-2">
        <Eye className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">
          {isRunning ? 'Live Preview' : 'Execution Result'}
        </span>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {messages.length === 0 && !isRunning && (
          <div className="text-sm text-muted-foreground/60 text-center py-8">
            No messages yet.
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className="space-y-1">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
              {msg.role === 'user' ? 'User' : 'Assistant'}
            </div>
            <div className="text-sm text-foreground whitespace-pre-wrap break-words">
              {typeof msg.content === 'string' ? msg.content : ''}
            </div>
          </div>
        ))}

        {isRunning && messages.length > 0 && !messages.some((m) => m.role === 'assistant') && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Generating...</span>
          </div>
        )}

        {isRunning && messages.length === 0 && (
          <div className="flex items-center gap-2 text-muted-foreground justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Waiting for execution...</span>
          </div>
        )}
      </div>
    </div>
  )
}
