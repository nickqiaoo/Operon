import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/**
 * Small file-system reads rendered inside chat messages. A long conversation
 * cites the same file dozens of times and remounts rows as it scrolls; one cache
 * entry per path turns that into one request.
 */

export const fsKeys = {
  all: ['fs'] as const,
  stat: (path: string) => ['fs', 'stat', path] as const,
  file: (path: string) => ['fs', 'file', path] as const,
  fileUrl: (path: string) => ['fs', 'file-url', path] as const,
}

/** Whether a cited file still exists. Rechecked after 30s; a click rechecks anyway. */
export function useFileStat(path: string | null) {
  return useQuery({
    queryKey: fsKeys.stat(path ?? ''),
    queryFn: () => api.stat(path!),
    enabled: !!path,
    staleTime: 30_000,
    // A missing file is an answer, not a failure worth retrying three times.
    retry: false,
  })
}

/** A URL an `<img>` can load the file from. */
export function useFileUrl(path: string | null) {
  return useQuery({
    queryKey: fsKeys.fileUrl(path ?? ''),
    queryFn: () => api.getFileUrl(path!),
    enabled: !!path,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** A text file's content (e.g. a plan file). */
export function useFileContent(path: string | null | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: fsKeys.file(path ?? ''),
    queryFn: () => api.readFile(path!),
    enabled: !!path && (options?.enabled ?? true),
    staleTime: 5_000,
    retry: false,
  })
}
