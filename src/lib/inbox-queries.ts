import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from './api'

/** TanStack Query layer for what the inbox answers in place: a chat's pending approvals. */

export type InboxPendingApproval = Awaited<ReturnType<typeof api.aiPendingApprovals>>['approvals'][number]

export const inboxKeys = {
  chatApprovals: (chatId: number) => ['inbox', 'approvals', chatId] as const,
  /** `version` is the inbox row's updatedAt: a new request re-raises the row. */
  chatApprovalsAt: (chatId: number, version: number) => ['inbox', 'approvals', chatId, version] as const,
}

export function useInboxChatApprovals(chatId: number, version: number) {
  return useQuery({
    queryKey: inboxKeys.chatApprovalsAt(chatId, version),
    queryFn: async () => (await api.aiPendingApprovals(chatId)).approvals ?? [],
    placeholderData: keepPreviousData,
  })
}
