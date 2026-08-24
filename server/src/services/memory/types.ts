/**
 * Memory Framework types.
 * Shared types for the memory subsystem.
 */

export type MemoryType =
  | 'user'
  | 'entities'
  | 'events'
  | 'cases'

export const MEMORY_TYPES: MemoryType[] = [
  'user',
  'entities',
  'events',
  'cases',
]

/** Singleton types are forced to slug `user` (see §3, rule 2). */
export const SINGLETON_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  'user',
])

export const SINGLETON_SLUG = 'user'

export interface MemoryPage {
  type: MemoryType
  slug: string
  truth: string
  revision: number
  updated_at: number
}

export interface MemoryTimelineEntry {
  id: number
  page_type: MemoryType
  page_slug: string
  entry: string
  occurred_at: number | null // NULL = event time unknown (use created_at for ordering)
  created_at: number
}

export interface TimelineInput {
  entry: string
  occurred_at?: number
}

/** Result of `memory_search` (and the REST page read) — one page with attached timeline slice. */
export interface MemoryPageResult {
  type: MemoryType
  slug: string
  truth: string
  revision: number
  updated_at: number
  /**
   * Relevance of this page to the query. Cross-encoder score (plus entity
   * boost) when the reranker ran, RRF fusion score on the degraded path — the
   * two are not on a comparable scale, so treat it as an ordering signal
   * within one response, never as an absolute threshold across responses.
   *
   * Optional because the engine's non-search readers (`memory_get`, timeline
   * paging) build the same shape without ranking anything.
   */
  score?: number
  timeline: Array<{
    id: number
    occurred_at: number | null // NULL = event time unknown
    entry: string
    matched: boolean
  }>
}

export interface UpsertResult {
  type: MemoryType
  slug: string
  revision: number
  /** True when the slug resolver merged into an existing page. */
  merged: boolean
  /** Only set when merged=true — the slug_hint the caller originally passed. */
  merged_from?: string
}
