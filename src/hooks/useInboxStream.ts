import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { subscribeEvents } from '@/lib/event-stream'
import { applyInboxEventToUnread } from '@/lib/inbox-queries'
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
    const subscription = subscribeEvents<InboxEvent>('inbox', {
      onEvent: (event) => {
        applyEvent(event)
        applyInboxEventToUnread(queryClient, event)
      },
    })
    return () => subscription.close()
  }, [applyEvent, queryClient])
}
