import { useCallback, useMemo, useRef } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { SubagentTranscript } from '@shared/background-tasks'
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
  /** `revision` is the caller's "something changed" marker (another call, finished). */
  subagentTranscript: (chatId: number, toolUseId: string, revision: string) =>
    ['subagent-transcript', chatId, toolUseId, revision] as const,
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

/**
 * A background sub-agent's steps, read from its transcript. One cache entry per
 * revision: a card that scrolls away and back (rows remount) reads it from
 * cache instead of refetching, and a new revision — the agent made another
 * call, or finished — fetches once while the previous steps stay on screen.
 */
export function useSubagentTranscript(
  chatId: number | undefined,
  toolUseId: string | undefined,
  enabled: boolean,
  revision: string,
): SubagentTranscript | undefined {
  const { data } = useQuery({
    queryKey: chatHistoryKeys.subagentTranscript(chatId ?? 0, toolUseId ?? '', revision),
    queryFn: async (): Promise<SubagentTranscript> => {
      const result = await api.aiSubagentTranscript(chatId!, toolUseId!)
      // Not written yet: the next revision tries again.
      if (result.error) throw new Error(result.error)
      return { steps: result.steps, finished: result.finished }
    },
    enabled: enabled && chatId != null && !!toolUseId,
    staleTime: Infinity,
    retry: false,
    placeholderData: keepPreviousData,
  })
  // A failed read (placeholder data isn't shown on error) keeps the last steps on screen.
  const identity = `${chatId}:${toolUseId}`
  const last = useRef<{ identity: string; transcript: SubagentTranscript } | null>(null)
  if (data) last.current = { identity, transcript: data }
  return data ?? (last.current?.identity === identity ? last.current.transcript : undefined)
}
