/**
 * Retrieval Pipeline — 3-way RRF fusion (design §4.5).
 *
 *   1. searchPageFTS     — FTS5 over memory_page.truth
 *   2. searchTimelineFTS — FTS5 over memory_timeline.entry
 *   3. searchVector      — vector search over truth chunks + timeline entries
 *
 * The three result lists are fused with Reciprocal Rank Fusion (k=60),
 * grouped by `(page_type, page_slug)`, then §4.1 aggregation attaches the
 * truth + hit timeline entries + fallback recent entries.
 */

import type { MemoryEngine, KeywordHit, VectorHit } from '../engine.js'
import { normalizeSlugKey } from '../engine.js'
import type { MemoryPageResult, MemoryType } from '../types.js'
import { getLocalLLM } from '../../vector/local-llm.js'

export interface MemorySearchOpts {
  /** Restrict to one or more memory types. Empty / undefined = all types. */
  types?: MemoryType[]
  /** Max pages to return after grouping. Default 10. */
  limit?: number
  /** Per-source candidate depth before fusion. Default 30. */
  perSourceLimit?: number
  /** Fallback timeline entries per page when nothing matches there. Default 3. */
  timelineFallback?: number
  /** Drop vector hits with cosine distance above this before fusion. Default 0.6. */
  maxVectorDistance?: number
  /** Drop FTS hits with normalized BM25 below this before fusion. Default 0. */
  minBm25?: number
  /** Minimum cross-encoder rerank score to keep a page. Default 0 (no floor). */
  rerankFloor?: number
  /** Enable lightweight entity-aware boosting against existing `entities` pages. Default true. */
  entityBoost?: boolean
  /** Max additive boost per matched entity, before diffusion decay. Default 0.15. */
  entityBoostWeight?: number
}

interface FusedHit {
  source_type: 'truth' | 'timeline'
  page_type: MemoryType
  page_slug: string
  timeline_id?: number
  fusedScore: number
}

const RRF_K = 60

/**
 * Lightweight entity-aware boost — inspired by mem0's entity boost (see
 * ../../../../mem0-source-analysis.md §5/§7) but without its spaCy entity store.
 * We reuse the existing `entities` pages instead: a query "names" an entity when
 * every token of the entity's slug appears in the query, and a candidate result
 * "mentions" it when those tokens appear in its truth/timeline text (or it IS
 * that entity page). Max additive boost per matched entity, before decay.
 */
const ENTITY_BOOST_WEIGHT = 0.15
/** Diffusion decay: the more candidates mention one entity, the less each gains. */
const ENTITY_DIFFUSION_ALPHA = 0.001

export async function memorySearch(
  engine: MemoryEngine,
  query: string,
  opts: MemorySearchOpts = {},
): Promise<MemoryPageResult[]> {
  const perSource = opts.perSourceLimit ?? 30
  const limit = opts.limit ?? 10
  const fallback = opts.timelineFallback ?? 3
  const maxVectorDistance = opts.maxVectorDistance ?? 0.6
  const minBm25 = opts.minBm25 ?? 0

  const types = opts.types && opts.types.length > 0 ? opts.types : undefined

  // Run three searches concurrently.
  const [pageHitsRaw, timelineHitsRaw, vectorHitsRaw] = await Promise.all([
    Promise.resolve(engine.searchPageFTS(query, types, perSource)),
    Promise.resolve(engine.searchTimelineFTS(query, types, perSource)),
    engine.searchVector(query, types, perSource),
  ])

  // Single-source relevance gate, applied BEFORE fusion: RRF only ranks, so a
  // below-floor candidate can't be rescued by rank and must be dropped at its
  // source. Vector distance is lower=better; normalized BM25 is higher=better.
  const pageHits = pageHitsRaw.filter((h) => h.score >= minBm25)
  const timelineHits = timelineHitsRaw.filter((h) => h.score >= minBm25)
  const vectorHits = vectorHitsRaw.filter((h) => h.distance <= maxVectorDistance)

  // Fuse keyword lists first (both are normalized BM25 in [0, 1), higher=better),
  // then fuse with the vector list. RRF only needs rank order, so the different
  // score scales between BM25 and cosine-distance do not matter.
  const keywordFused = rrfFusion([pageHits, timelineHits], hitKey)
  const allFused = rrfFusion([keywordFused, vectorHits], hitKey)

  // Group by (page_type, page_slug)
  const groups = new Map<string, FusedHit[]>()
  for (const h of allFused) {
    const key = `${h.page_type}|${h.page_slug}`
    let bucket = groups.get(key)
    if (!bucket) {
      bucket = []
      groups.set(key, bucket)
    }
    bucket.push(h)
  }

  // Detect which existing entities the query names, for a lightweight
  // entity-aware boost applied during reranking (see ENTITY_BOOST_WEIGHT).
  const queryEntities =
    opts.entityBoost === false ? [] : detectQueryEntities(engine, query)

  // Rank groups by best hit
  const rankedAll = Array.from(groups.entries())
    .map(([key, hits]) => ({
      key,
      hits,
      bestScore: Math.max(...hits.map((h) => h.fusedScore)),
    }))
    .sort((a, b) => b.bestScore - a.bestScore)

  // Over-fetch candidates for the precision reranker to reorder + floor. Also
  // pull in a named entity's own page even if fusion ranked it past the cut —
  // it can't be boosted later if it never reaches the reranker.
  const candidateLimit = Math.max(limit * 4, 24)
  const ranked = rankedAll.slice(0, candidateLimit)
  if (queryEntities.length > 0) {
    const seen = new Set(ranked.map((g) => g.key))
    for (const group of rankedAll.slice(candidateLimit)) {
      const [pageType, pageSlug] = splitKey(group.key)
      if (pageType !== 'entities') continue
      if (!queryEntities.some((e) => e.key === normalizeSlugKey(pageSlug))) continue
      if (seen.has(group.key)) continue
      ranked.push(group)
      seen.add(group.key)
    }
  }

  // Attach truth + timeline entries
  const results: MemoryPageResult[] = []
  for (const group of ranked) {
    const [pageType, pageSlug] = splitKey(group.key)
    if (!pageType) continue

    const page = engine.getPage(pageType, pageSlug)
    if (!page) continue

    const matchedTimelineIds = new Set<number>()
    for (const h of group.hits) {
      if (h.source_type === 'timeline' && typeof h.timeline_id === 'number') {
        matchedTimelineIds.add(h.timeline_id)
      }
    }

    // Also pick up timeline rows from keyword hits (timeline_id is the row_id)
    for (const h of timelineHits) {
      if (h.page_type === pageType && h.page_slug === pageSlug) {
        matchedTimelineIds.add(h.row_id)
      }
    }

    let timeline: MemoryPageResult['timeline']
    if (matchedTimelineIds.size > 0) {
      const rows = engine.getTimelineByIds(Array.from(matchedTimelineIds))
      timeline = rows
        // Sort by effective time (occurred_at, or created_at when unknown) so a
        // NULL occurred_at doesn't poison the comparison (NaN).
        .sort((a, b) => (b.occurred_at ?? b.created_at) - (a.occurred_at ?? a.created_at))
        .map((r) => ({
          id: r.id,
          occurred_at: r.occurred_at,
          entry: r.entry,
          matched: true,
        }))
    } else {
      // Fallback: recent N timeline entries for context
      const recent = engine.getTimelineRecent(pageType, pageSlug, fallback)
      timeline = recent.map((r) => ({
        id: r.id,
        occurred_at: r.occurred_at,
        entry: r.entry,
        matched: false,
      }))
    }

    results.push({
      type: page.type,
      slug: page.slug,
      truth: page.truth,
      revision: page.revision,
      updated_at: page.updated_at,
      // Fusion score. Overwritten with the cross-encoder score below when the
      // reranker is available; kept as-is on the degraded path.
      score: group.bestScore,
      timeline,
    })
  }

  return rerankResults(query, results, limit, opts, queryEntities)
}

// =============================================================================
// Precision rerank (cross-encoder)
// =============================================================================

/**
 * Reorder the fused candidates with the local Qwen3 cross-encoder and apply a
 * relevance floor. Rerank only reorders — the floor is what drops irrelevant
 * pages so an empty-match query returns nothing instead of the "least bad"
 * ones. Falls back to fusion order if the reranker is unavailable.
 */
async function rerankResults(
  query: string,
  results: MemoryPageResult[],
  limit: number,
  opts: MemorySearchOpts,
  queryEntities: QueryEntity[],
): Promise<MemoryPageResult[]> {
  if (results.length <= 1) return results.slice(0, limit)

  const boosts = computeEntityBoosts(results, queryEntities, opts.entityBoostWeight)
  const floor = opts.rerankFloor ?? 0
  const docs = results.map((r, i) => ({
    id: String(i),
    text: [r.truth, ...r.timeline.filter((t) => t.matched).map((t) => t.entry)]
      .filter(Boolean)
      .join('\n'),
  }))

  try {
    const scored = await getLocalLLM().rerank(query, docs)
    // Floor gates on the bare cross-encoder score so the entity boost can only
    // reorder relevant survivors, never rescue a below-floor page (mirrors
    // mem0's "threshold gates semantic, boost only re-ranks the rest").
    return scored
      .filter((s) => s.score >= floor)
      .map((s) => {
        const i = Number(s.id)
        return { result: results[i]!, score: s.score + (boosts[i] ?? 0) }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => ({ ...x.result, score: x.score }))
  } catch (err) {
    console.warn('[memory] rerank unavailable, using fusion order:', err)
    // Degraded path: keep fusion order but float entity-mentioning results up.
    // Stable sort — equal boosts (the common case) preserve the fusion order.
    return results
      .map((result, i) => ({ result, i, boost: boosts[i] ?? 0 }))
      .sort((a, b) => b.boost - a.boost || a.i - b.i)
      .slice(0, limit)
      .map((x) => x.result)
  }
}

// =============================================================================
// Lightweight entity-aware boost
// =============================================================================

export interface QueryEntity {
  /** normalizeSlugKey(entity page slug) — the canonical identity key. */
  key: string
  /** Significant tokens of the entity slug, e.g. "alice-smith" → [alice, smith]. */
  tokens: string[]
}

/** Lowercase alphanumeric token set of a text (shares normalizeSlugKey's rules). */
function entityTokenSet(text: string): Set<string> {
  return new Set(normalizeSlugKey(text).split('-').filter(Boolean))
}

/**
 * Find existing `entities` pages the query names. An entity matches when every
 * token of its slug appears as a query token, so multi-word names require all
 * parts (avoids "alice" matching every Alice) while single-token names are a
 * plain membership test.
 */
export function detectQueryEntities(engine: MemoryEngine, query: string): QueryEntity[] {
  const pages = engine.listPages({ type: 'entities', limit: 1000 })
  if (pages.length === 0) return []
  const queryTokens = entityTokenSet(query)
  if (queryTokens.size === 0) return []

  const matched: QueryEntity[] = []
  for (const page of pages) {
    const tokens = normalizeSlugKey(page.slug).split('-').filter(Boolean)
    if (tokens.length === 0) continue
    if (tokens.every((t) => queryTokens.has(t))) {
      matched.push({ key: normalizeSlugKey(page.slug), tokens })
    }
  }
  return matched
}

/** Whether a candidate names the entity — its own page, or its text mentions all tokens. */
export function resultMentionsEntity(result: MemoryPageResult, entity: QueryEntity): boolean {
  if (result.type === 'entities' && normalizeSlugKey(result.slug) === entity.key) {
    return true
  }
  const text = [result.truth, ...result.timeline.map((t) => t.entry)].join(' ')
  const tokens = entityTokenSet(text)
  return entity.tokens.every((t) => tokens.has(t))
}

/**
 * Per-result additive boost. For each query entity, the candidates mentioning it
 * share a boost that decays as more candidates mention it (diffusion decay): a
 * rare entity strongly lifts its single mention; a hub entity that nearly
 * everything mentions barely moves ranking. Multiple matched entities stack.
 */
export function computeEntityBoosts(
  results: MemoryPageResult[],
  queryEntities: QueryEntity[],
  weight: number = ENTITY_BOOST_WEIGHT,
): number[] {
  const boosts = new Array<number>(results.length).fill(0)
  if (queryEntities.length === 0) return boosts

  for (const entity of queryEntities) {
    const mentioners: number[] = []
    results.forEach((r, i) => {
      if (resultMentionsEntity(r, entity)) mentioners.push(i)
    })
    const n = mentioners.length
    if (n === 0) continue
    const decay = 1 / (1 + ENTITY_DIFFUSION_ALPHA * (n - 1) ** 2)
    const contribution = weight * decay
    for (const i of mentioners) boosts[i] += contribution
  }
  return boosts
}

// =============================================================================
// RRF fusion
// =============================================================================

type AnyHit = KeywordHit | VectorHit | FusedHit

/**
 * Reciprocal Rank Fusion over N ranked lists.
 *   RRF(d) = Σ 1 / (k + rank_i(d))
 */
function rrfFusion<T extends AnyHit>(
  lists: T[][],
  keyFn: (h: T) => string,
): FusedHit[] {
  const scores = new Map<string, FusedHit>()

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank]
      const key = keyFn(hit)
      const contribution = 1 / (RRF_K + rank + 1)

      const existing = scores.get(key)
      if (existing) {
        existing.fusedScore += contribution
      } else {
        scores.set(key, toFused(hit, contribution))
      }
    }
  }

  return Array.from(scores.values()).sort((a, b) => b.fusedScore - a.fusedScore)
}

function hitKey(h: AnyHit): string {
  if ('source_type' in h && h.source_type === 'timeline') {
    const id = 'timeline_id' in h ? h.timeline_id : 'row_id' in h ? h.row_id : undefined
    return `timeline:${h.page_type}:${h.page_slug}:${id ?? ''}`
  }
  return `truth:${h.page_type}:${h.page_slug}`
}

function toFused(hit: AnyHit, score: number): FusedHit {
  if ('fusedScore' in hit) {
    return { ...hit, fusedScore: score }
  }
  if ('source_type' in hit && hit.source_type === 'timeline') {
    const timelineId =
      'timeline_id' in hit ? hit.timeline_id : 'row_id' in hit ? hit.row_id : undefined
    return {
      source_type: 'timeline',
      page_type: hit.page_type,
      page_slug: hit.page_slug,
      timeline_id: timelineId,
      fusedScore: score,
    }
  }
  return {
    source_type: 'truth',
    page_type: hit.page_type,
    page_slug: hit.page_slug,
    fusedScore: score,
  }
}

function splitKey(key: string): [MemoryType | null, string] {
  const idx = key.indexOf('|')
  if (idx < 0) return [null, key]
  const typePart = key.slice(0, idx)
  const slugPart = key.slice(idx + 1)
  return [typePart as MemoryType, slugPart]
}
