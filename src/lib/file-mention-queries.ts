import { useQuery, type Query } from '@tanstack/react-query'
import { api } from './api'

/**
 * Queries behind the composer's `@` file picker: a fuzzy search across the
 * workspace, and a directory listing once the query names a folder ("src/").
 * Shared across every composer and refreshed after 30s — the per-instance maps
 * this replaces never expired, so a file created mid-session never showed up.
 */

export const fileMentionKeys = {
  all: (root: string) => ['file-mention', root] as const,
  search: (root: string, query: string) => ['file-mention', root, 'search', query] as const,
  dir: (root: string, dirPath: string) => ['file-mention', root, 'dir', dirPath] as const,
}

const MENTION_STALE_MS = 30_000
const MENTION_SEARCH_LIMIT = 50

interface MentionQueryOptions {
  enabled: boolean
}

type MentionEntries = Awaited<ReturnType<typeof api.findPaths>>

/**
 * Keep the previous keystroke's results on screen while the next one loads, so
 * the list doesn't blank between letters — but only within the same workspace:
 * another workspace's files must never show, even for a moment.
 */
function previousInSameRoot(root: string) {
  return (prev: MentionEntries | undefined, prevQuery: Query<MentionEntries> | undefined) =>
    prevQuery?.queryKey[1] === root ? prev : undefined
}

// Don't retry a typing lookup — the next keystroke is the retry.
const typingQueryDefaults = {
  staleTime: MENTION_STALE_MS,
  retry: false,
} as const

export function useFileMentionSearch(root: string | null, query: string, { enabled }: MentionQueryOptions) {
  return useQuery({
    queryKey: fileMentionKeys.search(root ?? '', query.toLowerCase()),
    queryFn: () => api.findPaths(root!, query, MENTION_SEARCH_LIMIT),
    enabled: enabled && !!root,
    placeholderData: previousInSameRoot(root ?? ''),
    ...typingQueryDefaults,
  })
}

export function useFileMentionDir(root: string | null, dirPath: string, { enabled }: MentionQueryOptions) {
  return useQuery({
    queryKey: fileMentionKeys.dir(root ?? '', dirPath),
    queryFn: () => api.readDir(dirPath),
    enabled: enabled && !!root,
    placeholderData: previousInSameRoot(root ?? ''),
    ...typingQueryDefaults,
  })
}
