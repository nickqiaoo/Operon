import { useEffect } from 'react'
import { api } from '@/lib/api'
import { subscribeSse } from '@/lib/sse'
import { useInboxStore } from '@/stores/inbox-store'
import type { InboxEvent } from '@/types/notification'

/**
 * Subscribe to the global inbox SSE stream so the bell badge + panel update live
 * when a chat finishes or a task changes status — in any project, even while its
 * tab is unmounted. Mount once at the app root.
 */
export function useInboxStream() {
  const applyEvent = useInboxStore((s) => s.applyEvent)

  useEffect(() => {
    const subscription = subscribeSse<InboxEvent>({
      url: () => api.inboxStreamUrl(),
      onEvent: applyEvent,
    })
    return () => subscription.close()
  }, [applyEvent])
}
