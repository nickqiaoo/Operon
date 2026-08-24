import { useCallback, useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from './api'

/**
 * TanStack Query layer for the per-workspace conversation lists (the desktop
 * history popover and the mobile Chats screen).
 *
 * The point of moving these off `useState` is the cache key. Both surfaces used
 * to hold their rows in component state and refetch on workspace change, which
 * meant that between the switch and the response landing they were rendering the
 * *previous* workspace's conversations — invisible on desktop (a few ms) and a
 * plainly wrong list on web. Keying by workspace makes that impossible: each
 * workspace has its own cache slot, so a switch shows either that workspace's
 * last known rows or a skeleton, never another one's.
 */

export type ChatHistoryListItem = Awaited<ReturnType<typeof api.chatHistoryList>>[number]

export const chatHistoryKeys = {
  list: (workspaceId: number | null | undefined, tp?: string) =>
    ['chat-history-list', workspaceId ?? 'all', tp ?? 'all'] as const,
}

/** Keeps the first row per id — a chat that moves across the offset boundary between pages comes back twice. */
const dedupeById = (items: ChatHistoryListItem[]): ChatHistoryListItem[] => {
  const seen = new Set<number>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

interface UseChatHistoryListOptions {
  workspaceId: number | null | undefined
  /** Server-side `tp` filter ("chat", "canvas", …). Omit for every kind. */
  tp?: string
  pageSize: number
  /** Skip fetching while the surface is hidden (popover closed, conversation open). */
  enabled?: boolean
  /**
   * How long a fetched page counts as fresh. 0 refetches every time the surface
   * re-enables, which is what a list you keep navigating back to wants; a few
   * seconds is enough for a popover the user toggles repeatedly.
   */
  staleTime?: number
}

export function useChatHistoryList({
  workspaceId,
  tp,
  pageSize,
  enabled = true,
  staleTime = 5_000,
}: UseChatHistoryListOptions) {
  const query = useInfiniteQuery({
    queryKey: chatHistoryKeys.list(workspaceId, tp),
    queryFn: ({ pageParam }) =>
      api.chatHistoryList(workspaceId ?? undefined, tp, { limit: pageSize, offset: pageParam }),
    initialPageParam: 0,
    // A short page means the server ran out of rows. Offset counts raw rows, not
    // deduped ones, or the next page would skip whatever we dropped.
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === pageSize
        ? allPages.reduce((total, page) => total + page.length, 0)
        : undefined,
    enabled,
    staleTime,
  })

  const items = useMemo(
    () => dedupeById(query.data?.pages.flat() ?? []),
    [query.data]
  )

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query
  const loadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage) return
    void fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  return {
    items,
    hasMore: hasNextPage,
    /**
     * First load for *this* workspace, with nothing cached to show. Not
     * `isPending`: a disabled infinite query also reports pending, which would
     * leave a skeleton up on a surface that isn't even fetching.
     */
    isInitialLoading: query.isFetching && query.data === undefined,
    isLoadingMore: isFetchingNextPage,
    loadMore,
  }
}
