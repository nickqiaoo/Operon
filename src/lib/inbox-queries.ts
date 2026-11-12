import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { InboxEvent, Notification } from '@/types/notification'

/** TanStack Query layer for the inbox: a chat's pending approvals, and what is still unread. */

export type InboxPendingApproval = Awaited<ReturnType<typeof api.aiPendingApprovals>>['approvals'][number]

const UNREAD_LIMIT = 100

export const inboxKeys = {
  chatApprovals: (chatId: number) => ['inbox', 'approvals', chatId] as const,
  /** `version` is the inbox row's updatedAt: a new request re-raises the row. */
  chatApprovalsAt: (chatId: number, version: number) => ['inbox', 'approvals', chatId, version] as const,
  /** Unread rows, newest first: what the sidebar's Active list draws on. */
  unread: () => ['inbox', 'unread'] as const,
}

export function useInboxChatApprovals(chatId: number, version: number) {
  return useQuery({
    queryKey: inboxKeys.chatApprovalsAt(chatId, version),
    queryFn: async () => (await api.aiPendingApprovals(chatId)).approvals ?? [],
    placeholderData: keepPreviousData,
  })
}

/** Kept current by `applyInboxEventToUnread` from the inbox stream; refetched on focus to heal a dropped stream. */
export function useInboxUnread() {
  return useQuery({
    queryKey: inboxKeys.unread(),
    queryFn: async () => (await api.inboxList({ unreadOnly: true, limit: UNREAD_LIMIT })).notifications,
    staleTime: 30_000,
  })
}

/** Fold one live inbox event into the cached unread list, so it changes without a refetch. */
export function applyInboxEventToUnread(client: QueryClient, event: InboxEvent): void {
  const key = inboxKeys.unread()
  if (event.type === 'counts' || client.getQueryData(key) === undefined) return
  client.setQueryData<Notification[]>(key, (current = []) => {
    switch (event.type) {
      case 'notification_upsert': {
        const next = event.notification
        const rest = current.filter((n) => n.id !== next.id)
        if (next.readAt != null || next.archivedAt != null) return rest
        return [next, ...rest].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      }
      case 'notification_read':
      case 'notification_archive': {
        const ids = new Set(event.ids)
        return current.filter((n) => !ids.has(n.id))
      }
    }
  })
}
