import { useCallback, useEffect, useMemo, useRef } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChatStatus } from 'ai'
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
  /**
   * The sidebar tree's latest conversations of one workspace. Under `list`'s
   * prefix, so invalidating a workspace's list refreshes its tree rows too.
   */
  workspaceLatest: (workspaceId: number) =>
    ['chat-history-list', workspaceId, 'chat', 'sidebar'] as const,
  /** Every sidebar tree list, to refresh them together when a turn starts or ends. */
  allLists: () => ['chat-history-list'] as const,
  /** The user's own conversations across every workspace, most recently active first. */
  recent: () => ['chat-history-recent'] as const,
  /** `revision` is the caller's "something changed" marker (another call, finished). */
  subagentTranscript: (chatId: number, toolUseId: string, revision: string) =>
    ['subagent-transcript', chatId, toolUseId, revision] as const,
}

/** Keeps the first row per id when an update moves a chat across a page boundary. */
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

  const { fetchNextPage, hasNextPage, isFetchingNextPage, refetch } = query
  const loadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage) return
    void fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])
  /** Re-read every loaded page now (pull to refresh); resolves when it lands. */
  const refresh = useCallback(() => refetch(), [refetch])

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
    refresh,
  }
}

const WORKSPACE_CHAT_PREVIEW_SIZE = 5
const WORKSPACE_CHAT_PAGE_SIZE = 10

/** Sidebar conversations, mounted only for expanded projects. */
export function useWorkspaceLatestChats(workspaceId: number) {
  const queryClient = useQueryClient()
  const queryKey = chatHistoryKeys.workspaceLatest(workspaceId)
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | number | null,
    queryFn: ({ pageParam, signal }) => api.workspaceChatHistoryPage(
      workspaceId,
      pageParam === null ? WORKSPACE_CHAT_PREVIEW_SIZE : WORKSPACE_CHAT_PAGE_SIZE,
      pageParam,
      signal,
    ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 15_000,
    refetchInterval: 60_000,
  })
  const chats = useMemo(() => dedupeById(query.data?.pages.flatMap((page) => page.items) ?? []), [query.data])
  type WorkspaceLatestData = NonNullable<typeof query.data>

  const showLess = useCallback(() => {
    queryClient.setQueryData<WorkspaceLatestData>(
      chatHistoryKeys.workspaceLatest(workspaceId),
      (data) => data && data.pages.length > 1
        ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
        : data,
    )
  }, [queryClient, workspaceId])

  // "Show more" is for this look at the list only: folding the workspace
  // unmounts the list, and the pages it loaded stay in the cache — so the next
  // unfold would come back at full length. Trim back to the preview on the way out.
  useEffect(() => showLess, [showLess])

  return {
    chats,
    hasMore: query.hasNextPage,
    expanded: chats.length > WORKSPACE_CHAT_PREVIEW_SIZE,
    isFetching: query.isFetching,
    loadMore: () => void query.fetchNextPage({ cancelRefetch: false }),
    showLess,
  }
}

const RECENT_CHATS_LIMIT = 30

/**
 * Recently active conversations everywhere — the sidebar Active list's Recent
 * group. Server-side rather than "tabs I opened": closing a tab does not mean
 * the work stopped, and a chat driven from the phone never had a tab here.
 * Invalidated when a turn starts or ends; the interval catches the rest.
 */
export function useRecentChats() {
  return useQuery({
    queryKey: chatHistoryKeys.recent(),
    queryFn: () => api.chatHistoryList(undefined, 'chat', { limit: RECENT_CHATS_LIMIT }),
    staleTime: 15_000,
    refetchInterval: 60_000,
  })
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

export const turnDiffKeys = {
  all: ['turn-diffs'] as const,
  detail: (chatId: number | undefined, cwd: string | null) =>
    ['turn-diffs', chatId ?? null, cwd] as const,
}

export function turnDiffsEnabled(chatId: number | undefined, cwd: string | null, status: ChatStatus, liveTurnActive: boolean | null) {
  // Reopened chats start locally ready before resume attaches. Wait for presence:
  // null means the node has not yet answered whether a turn is still running.
  return chatId !== undefined && !!cwd && status !== 'streaming' && status !== 'submitted' && liveTurnActive === false
}

export function useTurnDiffs(chatId: number | undefined, cwd: string | null, status: ChatStatus, liveTurnActive: boolean | null) {
  const { data } = useQuery({
    queryKey: turnDiffKeys.detail(chatId, cwd),
    queryFn: () => api.aiGetTurnDiffs(chatId!, cwd!),
    enabled: turnDiffsEnabled(chatId, cwd, status, liveTurnActive),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  })
  return chatId === undefined || !cwd ? null : data ?? null
}

/**
 * The newest turn of a chat that changed files, read from the cache
 * {@link useTurnDiffs} fills. Never fetches on its own: that hook already waits
 * for the turn to finish, and a fetch from here could expose a half-done turn.
 */
export function useLatestChangedTurnUid(chatId: number | undefined, cwd: string | null) {
  const { data } = useQuery({
    queryKey: turnDiffKeys.detail(chatId, cwd),
    queryFn: () => api.aiGetTurnDiffs(chatId!, cwd!),
    enabled: false,
    select: (diffs) => diffs.turns.at(-1)?.messageUid,
  })
  return data
}
