import { QueueItem, QueueItemAction, QueueItemActions, QueueItemContent, QueueItemDescription, QueueItemIndicator } from '@/components/ai-elements/queue'
import { cn } from '@/lib/utils'
import { AlertCircle, Clock3, LoaderCircle, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, requestVia } from '@/lib/api-client'
import { useChatTransport } from '@/lib/chat-api-context'
import { useIntl } from 'react-intl'
import { displaySendTime, scheduleText } from './schedule-messages'

interface ScheduledItem { id: string; sendAt: number; preview: string; state: 'pending' | 'sending' | 'failed'; error?: string }
export const scheduledKey = (node: string | undefined, chatId: number) => ['scheduled-messages', node ?? 'local', chatId] as const

export function ScheduledTray({ chatId, busy, visible }: { chatId: number; busy: boolean; visible: boolean }) {
  const intl = useIntl()
  const transport = useChatTransport()
  const path = `/ai/scheduled/${chatId}`
  const query = useQuery({
    queryKey: scheduledKey(transport.nodeId, chatId),
    queryFn: () => requestVia<ScheduledItem[]>(transport, path),
    enabled: visible,
    refetchInterval: q => {
      const active = q.state.data?.filter(item => item.state !== 'failed')
      if (!active?.length) return false
      const next = Math.min(...active.map(item => item.sendAt))
      return Math.max(1500, Math.min(60_000, next - Date.now()))
    },
  })
  async function cancel(id: string) {
    try { await requestVia(transport, path + '/' + encodeURIComponent(id), { method: 'DELETE' }) }
    catch (err) { toast.error(intl.formatMessage(err instanceof ApiError && err.status === 409 ? scheduleText.gone : scheduleText.cancelError)) }
    void query.refetch()
  }
  return query.data?.map(item => {
    const failed = item.state === 'failed'
    const sending = item.state === 'sending'
    const time = displaySendTime(intl, item.sendAt)
    const action = intl.formatMessage(failed ? scheduleText.dismiss : scheduleText.cancel)
    const description = failed ? intl.formatMessage(scheduleText.failed)
      : sending ? intl.formatMessage(scheduleText.sending)
      : busy && item.sendAt <= Date.now() ? intl.formatMessage(scheduleText.waiting) : time
    return (
      <QueueItem key={item.id} status={sending ? 'running' : failed ? 'error' : undefined} className="h-7 w-full">
        <QueueItemIndicator>
          {sending ? <LoaderCircle className="size-3.5 animate-spin" /> : failed ? <AlertCircle className="size-3.5" /> : <Clock3 className="size-3.5" />}
        </QueueItemIndicator>
        <QueueItemContent title={item.preview} className="text-foreground">{item.preview}</QueueItemContent>
        <QueueItemDescription title={item.error || time} className={cn('ml-auto shrink-0 text-xs', failed && 'text-status-error')}>
          {description}
        </QueueItemDescription>
        {!sending && (
          <QueueItemActions className="-mr-1">
            <QueueItemAction onClick={() => void cancel(item.id)} aria-label={action} title={action}><X /></QueueItemAction>
          </QueueItemActions>
        )}
      </QueueItem>
    )
  })
}
