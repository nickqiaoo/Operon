import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { subscribeEvents } from '@/lib/event-stream'
import { applyInboxEventToUnread } from '@/lib/inbox-queries'
import { applyChannelUnread, channelUnreadKey } from '@/lib/channel-queries'
import { useInboxStore } from '@/stores/inbox-store'
import type { InboxEvent } from '@/types/notification'

/**
 * Subscribe to the global inbox SSE stream so the bell badge + panel update live
 * when a chat finishes or a task changes status — in any project, even while its
 * tab is unmounted. Mount once at the app root.
 */
export function useInboxStream() {
  const applyEvent = useInboxStore((s) => s.applyEvent)
  const queryClient = useQueryClient()

  useEffect(() => {
    let dropped = false
    const subscription = subscribeEvents<InboxEvent>('inbox', {
      onEvent: (event) => {
        if (event.type === 'channel_unread') {
          applyChannelUnread(queryClient, event.unread)
          return
        }
        applyEvent(event)
        applyInboxEventToUnread(queryClient, event)
        // `counts` is also the snapshot a reconnect opens with: whatever channel
        // unread changed while the stream was down, re-read it once.
        if (event.type === 'counts' && dropped) {
          dropped = false
          void queryClient.invalidateQueries({ queryKey: channelUnreadKey })
        }
      },
      onError: () => {
        dropped = true
      },
    })
    return () => subscription.close()
  }, [applyEvent, queryClient])
}
