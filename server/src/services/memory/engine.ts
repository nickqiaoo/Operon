/**
 * MemoryEngine — low-level SQLite + vector-store backing for the Memory Framework.
 *
 * All page and timeline CRUD, slug
 * resolution, FTS keyword search, and vector chunk I/O live here. Retrieval
 * pipeline composition is in ./search/hybrid.ts.
 */

import type Database from 'better-sqlite3'
import type { SearchResult as VectorStoreHit, SqliteVecStore } from '../vector/sqlite-vec-store.js'
import { generateEmbedding } from '../vector/embeddings.js'
import { createRuntimeLogger } from '@operon/agent-runtime'
import {
  MEMORY_TYPES,
  SINGLETON_SLUG,
  SINGLETON_TYPES,
  type MemoryPage,
  type MemoryTimelineEntry,
  type MemoryType,
  type TimelineInput,
  type UpsertResult,
} from './types.js'

const logger = createRuntimeLogger('memory-engine')

/** Vector-store collection name for the memory framework. */
export const VECTOR_COLLECTION = 'memory'

/**
 * Char budget for a truth before its single whole-page embedding risks tail
 * truncation by the embed context (~2048 tokens). Over this we warn so the
 * page gets compacted — truth is meant to be a concise current-state summary.
 */
const TRUTH_VEC_CHAR_BUDGET = 1500

// =============================================================================
// Row shapes
// =============================================================================

interface MemoryPageRow {
  type: string
  slug: string
  truth: string
  revision: number
  updated_at: number
}

interface MemoryTimelineRow {
  id: number
  page_type: string
  page_slug: string
  entry: string
  occurred_at: number | null // NULL = event time unknown
  created_at: number
}

// =============================================================================
// Public hit shapes used by the retrieval pipeline
// =============================================================================

export interface KeywordHit {
  source_type: 'truth' | 'timeline'
  page_type: MemoryType
  page_slug: string
  /** Row id: memory_page.rowid for truth, memory_timeline.id for timeline. */
  row_id: number
  /** Normalized BM25 score in [0, 1), higher is better. */
  score: number
}

export interface VectorHit {
  source_type: 'truth' | 'timeline'
  page_type: MemoryType
  page_slug: string
  /** For timeline hits. */
  timeline_id?: number
  /** Raw cosine distance from the vector store, lower is better. */
  distance: number
}

/** One duplicate candidate surfaced by `findDuplicateCandidates`. */
export interface DuplicateCandidate {
  /** Slug of the existing page that might be the same thing. */
  slug: string
  /** That page's current truth, so the caller (agent) can judge the merge. */
  truth: string
  /** Page revision the caller must use if it decides to merge. */
  revision: number
  /** Raw cosine distance from the incoming truth, lower = more similar. */
  distance: number
}

export class MemoryPageExistsError extends Error {
  readonly page: MemoryPage

  constructor(page: MemoryPage) {
    super(`memory page already exists: ${page.type}/${page.slug}`)
    this.name = 'MemoryPageExistsError'
    this.page = page
  }
}

export class MemoryPageNotFoundError extends Error {
  readonly type: MemoryType
  readonly slug: string

  constructor(type: MemoryType, slug: string) {
    super(`memory page not found: ${type}/${slug}`)
    this.name = 'MemoryPageNotFoundError'
    this.type = type
    this.slug = slug
  }
}

export class MemoryRevisionConflictError extends Error {
  readonly page: MemoryPage

  constructor(page: MemoryPage, expectedRevision: number) {
    super(
      `memory page revision conflict: ${page.type}/${page.slug} expected ${expectedRevision}, current ${page.revision}`,
    )
    this.name = 'MemoryRevisionConflictError'
    this.page = page
  }
}

// =============================================================================
// Engine
// =============================================================================

export class MemoryEngine {
  private readonly db: Database.Database
  private readonly vectors: SqliteVecStore | null

  constructor(db: Database.Database, vectors: SqliteVecStore | null) {
    this.db = db
    this.vectors = vectors
  }

  // ---------------------------------------------------------------------------
  // Page reads
  // ---------------------------------------------------------------------------

  getPage(type: MemoryType, slug: string): MemoryPage | null {
    const row = this.db
      .prepare(
        'SELECT type, slug, truth, revision, updated_at FROM memory_page WHERE type = ? AND slug = ?',
      )
      .get(type, slug) as MemoryPageRow | undefined
    return row ? this.rowToPage(row) : null
  }

  getPageByRowid(rowid: number): MemoryPage | null {
    const row = this.db
      .prepare('SELECT type, slug, truth, revision, updated_at FROM memory_page WHERE rowid = ?')
      .get(rowid) as MemoryPageRow | undefined
    return row ? this.rowToPage(row) : null
  }

  listPages(opts: { type?: MemoryType; limit?: number } = {}): MemoryPage[] {
    const limit = opts.limit ?? 200
    const rows = opts.type
      ? (this.db
          .prepare(
            'SELECT type, slug, truth, revision, updated_at FROM memory_page WHERE type = ? ORDER BY updated_at DESC LIMIT ?',
          )
          .all(opts.type, limit) as MemoryPageRow[])
      : (this.db
          .prepare(
            'SELECT type, slug, truth, revision, updated_at FROM memory_page ORDER BY updated_at DESC LIMIT ?',
          )
          .all(limit) as MemoryPageRow[])
    return rows.map((r) => this.rowToPage(r))
  }

  async deletePage(type: MemoryType, slug: string): Promise<boolean> {
    const existing = this.getPage(type, slug)
    if (!existing) return false

    const timelineIds = (this.db
      .prepare('SELECT id FROM memory_timeline WHERE page_type = ? AND page_slug = ?')
      .all(type, slug) as { id: number }[]).map((r) => r.id)

    const tx = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM memory_timeline WHERE page_type = ? AND page_slug = ?')
        .run(type, slug)
      this.db
        .prepare('DELETE FROM memory_alias WHERE type = ? AND page_slug = ?')
        .run(type, slug)
      this.db.prepare('DELETE FROM memory_page WHERE type = ? AND slug = ?').run(type, slug)
    })
    tx()

    try {
      if (this.vectors) {
        this.vectors.delete(VECTOR_COLLECTION, truthVecId(type, slug))
        for (const id of timelineIds) this.vectors.delete(VECTOR_COLLECTION, timelineEntryId(id))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(`vector cleanup failed on delete type=${type} slug=${slug} err=${msg}`)
    }
    return true
  }

  /**
   * Write-time dedup probe (replaces the old background `dedupePages` pass).
   * Embeds the incoming truth and returns the nearest existing pages of the
   * same type by truth-vector cosine distance, each with its current truth so
   * the caller can judge a merge. The decision (merge / new) is made one level
   * up in `operations.ts` and, when ambiguous, delegated back to the running
   * agent — this method only surfaces candidates, it never writes.
   *
   * Returns [] for singleton types (one page by construction) and when no
   * embedding backend is available.
   */
  async findDuplicateCandidates(
    type: MemoryType,
    truth: string,
    k = 5,
  ): Promise<DuplicateCandidate[]> {
    if (SINGLETON_TYPES.has(type)) return []
    if (!this.vectors) return []
    const vec = await generateEmbedding(truth)
    if (!vec) return []

    const hits = this.vectors.search(VECTOR_COLLECTION, vec, k, {
      category: 'truth',
      scope: type,
    })

    const out: DuplicateCandidate[] = []
    for (const h of hits) {
      const slug = String(h.fields.source_id ?? '')
      if (!slug) continue
      const page = this.getPage(type, slug)
      if (!page) continue
      out.push({ slug, truth: page.truth, revision: page.revision, distance: h.score })
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // Timeline reads
  // ---------------------------------------------------------------------------

  getTimelineRecent(type: MemoryType, slug: string, limit: number): MemoryTimelineEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, page_type, page_slug, entry, occurred_at, created_at
           FROM memory_timeline
          WHERE page_type = ? AND page_slug = ?
          ORDER BY COALESCE(occurred_at, created_at) DESC, id DESC
          LIMIT ?`,
      )
      .all(type, slug, limit) as MemoryTimelineRow[]
    return rows.map((r) => this.rowToTimeline(r))
  }

  /** Paged timeline read by occurred_at DESC, with cursor = last seen occurred_at. */
  pageTimeline(
    type: MemoryType,
    slug: string,
    opts: { since?: number; until?: number; limit?: number; cursor?: number } = {},
  ): MemoryTimelineEntry[] {
    const limit = opts.limit ?? 50
    const clauses: string[] = ['page_type = ?', 'page_slug = ?']
    const params: unknown[] = [type, slug]

    // Filter/paginate by effective time = occurred_at, falling back to created_at
    // when the event time is unknown (NULL), so unknown-time entries still page.
    if (typeof opts.since === 'number') {
      clauses.push('COALESCE(occurred_at, created_at) >= ?')
      params.push(opts.since)
    }
    if (typeof opts.until === 'number') {
      clauses.push('COALESCE(occurred_at, created_at) <= ?')
      params.push(opts.until)
    }
    if (typeof opts.cursor === 'number') {
      clauses.push('COALESCE(occurred_at, created_at) < ?')
      params.push(opts.cursor)
    }
    params.push(limit)

    const rows = this.db
      .prepare(
        `SELECT id, page_type, page_slug, entry, occurred_at, created_at
           FROM memory_timeline
          WHERE ${clauses.join(' AND ')}
          ORDER BY COALESCE(occurred_at, created_at) DESC, id DESC
          LIMIT ?`,
      )
      .all(...params) as MemoryTimelineRow[]
    return rows.map((r) => this.rowToTimeline(r))
  }

  getTimelineByIds(ids: number[]): MemoryTimelineEntry[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT id, page_type, page_slug, entry, occurred_at, created_at
           FROM memory_timeline
          WHERE id IN (${placeholders})`,
      )
      .all(...ids) as MemoryTimelineRow[]
    return rows.map((r) => this.rowToTimeline(r))
  }

  // ---------------------------------------------------------------------------
  // Upsert (§4.3 — slug resolver + persist)
  // ---------------------------------------------------------------------------

  async createPage(
    type: MemoryType,
    slugHint: string,
    truth: string,
    timeline: TimelineInput,
  ): Promise<UpsertResult> {
	    if (!truth.trim()) throw new Error('truth is required')
	    if (!timeline.entry.trim()) {
	      throw new Error('timeline entry is required — every truth change must be explained')
	    }

    const truthVec = await this.embedTruth(type, slugHint, truth)
    const resolved = this.resolveSlug(type, slugHint)
    const existing = this.getPage(type, resolved.slug)
    if (existing) throw new MemoryPageExistsError(existing)

    const now = Date.now()
    // NULL when the agent didn't supply a time: "unknown", NOT "happened now".
    // created_at (below) is the write time; occurred_at is the business time.
    const occurredAt = timeline.occurred_at ?? null

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memory_page (type, slug, truth, revision, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(type, resolved.slug, truth, 1, now)

      const r = this.db
        .prepare(
          `INSERT INTO memory_timeline (page_type, page_slug, entry, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(type, resolved.slug, timeline.entry, occurredAt, now)
      return Number(r.lastInsertRowid)
    })

    const timelineId = tx()

    // The vector store is an index — a failure here does not fail the upsert.
    try {
      await this.storeTruthVector(type, resolved.slug, truthVec)
      await this.indexTimelineEntry(type, resolved.slug, timelineId, timeline.entry)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        `vector sync failed; FTS remains authoritative type=${type} slug=${resolved.slug} err=${msg}`,
      )
    }

    return {
      type,
      slug: resolved.slug,
      revision: 1,
      merged: resolved.merged,
      ...(resolved.merged && resolved.slug !== slugHint ? { merged_from: slugHint } : {}),
    }
  }

  async replacePageTruth(
    type: MemoryType,
    slugHint: string,
    truth: string,
    timeline: TimelineInput,
    opts: { baseRevision?: number } = {},
  ): Promise<UpsertResult> {
	    if (!truth.trim()) throw new Error('truth is required')
	    if (!timeline.entry.trim()) {
	      throw new Error('timeline entry is required — every truth change must be explained')
	    }

    const truthVec = await this.embedTruth(type, slugHint, truth)
    const resolved = this.resolveSlug(type, slugHint)

    const now = Date.now()
    // NULL when the agent didn't supply a time: "unknown", NOT "happened now".
    // created_at (below) is the write time; occurred_at is the business time.
    const occurredAt = timeline.occurred_at ?? null

    const tx = this.db.transaction(() => {
      const existing = this.getPage(type, resolved.slug)
      if (!existing) throw new MemoryPageNotFoundError(type, resolved.slug)
      if (opts.baseRevision !== undefined && existing.revision !== opts.baseRevision) {
        throw new MemoryRevisionConflictError(existing, opts.baseRevision)
      }

      const nextRevision = existing.revision + 1
      this.db
        .prepare(
          `UPDATE memory_page
              SET truth = ?, revision = ?, updated_at = ?
            WHERE type = ? AND slug = ?`,
        )
        .run(truth, nextRevision, now, type, resolved.slug)

      const r = this.db
        .prepare(
          `INSERT INTO memory_timeline (page_type, page_slug, entry, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(type, resolved.slug, timeline.entry, occurredAt, now)

      return { timelineId: Number(r.lastInsertRowid), revision: nextRevision }
    })

    const { timelineId, revision } = tx()

    try {
      await this.storeTruthVector(type, resolved.slug, truthVec)
      await this.indexTimelineEntry(type, resolved.slug, timelineId, timeline.entry)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        `vector sync failed; FTS remains authoritative type=${type} slug=${resolved.slug} err=${msg}`,
      )
    }

    return {
      type,
      slug: resolved.slug,
      revision,
      merged: resolved.merged,
      ...(resolved.merged && resolved.slug !== slugHint ? { merged_from: slugHint } : {}),
    }
  }

  async upsert(
    type: MemoryType,
    slugHint: string,
    truth: string,
    timeline: TimelineInput,
  ): Promise<UpsertResult> {
    const resolved = this.resolveSlug(type, slugHint)
    const existing = this.getPage(type, resolved.slug)
    if (existing) return this.replacePageTruth(type, slugHint, truth, timeline)
    return this.createPage(type, slugHint, truth, timeline)
  }

  // ---------------------------------------------------------------------------
  // Slug resolver (§4.3)
  // ---------------------------------------------------------------------------

  /**
   * Identity-first slug resolution for a write (cheap, deterministic, no LLM):
   *   1. exact slug  → a page already lives here, reuse it (stable-slug writes)
   *   2. slug key    → an existing slug that normalizes to the same identity
   * Semantic (vector) dedup is no longer auto-applied here — that decision moved
   * to `operations.ts` (write-time guard + agent reconcile). This keeps `upsert`
   * deterministic: it only folds writes that share a stable identifier.
   */
  private resolveSlug(type: MemoryType, slugHint: string): { slug: string; merged: boolean } {
    if (SINGLETON_TYPES.has(type)) {
      return { slug: SINGLETON_SLUG, merged: slugHint !== SINGLETON_SLUG }
    }

    const cleanHint = slugHint.trim()
    if (!cleanHint) throw new Error('slug_hint is required for non-singleton types')

    const existing = this.resolveExistingSlug(type, cleanHint)
    if (existing) return { slug: existing, merged: existing !== cleanHint }
    return { slug: cleanHint, merged: false }
  }

  /**
   * Resolve a slug hint to an EXISTING page slug by identity alone, or null when
   * no identity match exists. Three deterministic signals, in order:
   *   1. exact slug
   *   2. normalized slug key (case / separators / punctuation)
   *   3. learned alias — a name previously folded into a canonical page
   * Public so the write-time guard can tell "this is a known page, write
   * straight through" from "this would mint a new page, run the dedup probe".
   */
  resolveExistingSlug(type: MemoryType, slugHint: string): string | null {
    if (SINGLETON_TYPES.has(type)) return SINGLETON_SLUG
    const cleanHint = slugHint.trim()
    if (!cleanHint) return null

    if (this.getPage(type, cleanHint)) return cleanHint

    const wantKey = normalizeSlugKey(cleanHint)
    if (!wantKey) return null

    const rows = this.db
      .prepare('SELECT slug FROM memory_page WHERE type = ?')
      .all(type) as { slug: string }[]
    const match = rows.find((r) => normalizeSlugKey(r.slug) === wantKey)
    if (match) return match.slug

    // Learned alias: a name we've already folded into a canonical page. Ignore a
    // dangling alias whose target page no longer exists.
    const aliasRow = this.db
      .prepare('SELECT page_slug FROM memory_alias WHERE type = ? AND alias_key = ?')
      .get(type, wantKey) as { page_slug: string } | undefined
    if (aliasRow && this.getPage(type, aliasRow.page_slug)) return aliasRow.page_slug

    return null
  }

  /**
   * Record `aliasHint` as another name for the existing page `pageSlug` of this
   * type, so a future write under that name resolves straight to the page. Called
   * by the write-time guard whenever a differently-named write is folded into a
   * canonical page after an agent merge decision.
   *
   * No-ops when the alias adds nothing or would be unsafe:
   *   - singleton types (one page by construction)
   *   - the alias key equals the target's own slug key (already covered by step 2)
   *   - a distinct real page already owns that slug key (don't shadow a page)
   * On an existing (type, alias_key) the first mapping wins (INSERT OR IGNORE),
   * keeping resolution unambiguous.
   */
  recordAlias(type: MemoryType, aliasHint: string, pageSlug: string): void {
    if (SINGLETON_TYPES.has(type)) return
    if (!this.getPage(type, pageSlug)) return
    const aliasKey = normalizeSlugKey(aliasHint)
    if (!aliasKey) return
    if (aliasKey === normalizeSlugKey(pageSlug)) return

    const ownsKey = (
      this.db.prepare('SELECT slug FROM memory_page WHERE type = ?').all(type) as { slug: string }[]
    ).some((r) => normalizeSlugKey(r.slug) === aliasKey)
    if (ownsKey) return

    this.db
      .prepare(
        'INSERT OR IGNORE INTO memory_alias (type, alias_key, page_slug, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(type, aliasKey, pageSlug, Date.now())
  }

  // ---------------------------------------------------------------------------
  // Truth vector (one whole-page embedding per page; no chunking)
  // ---------------------------------------------------------------------------

  /** Embed a truth, warning if it is long enough to risk tail truncation. */
  private async embedTruth(
    type: MemoryType,
    slug: string,
    truth: string,
  ): Promise<number[] | null> {
    if (truth.length > TRUTH_VEC_CHAR_BUDGET) {
      logger.warn(
        `truth exceeds embed budget (${truth.length} > ${TRUTH_VEC_CHAR_BUDGET} chars); ` +
          `tail may be truncated in the vector — compact this page. type=${type} slug=${slug}`,
      )
    }
    return generateEmbedding(truth)
  }

  /** Store the single whole-truth vector for a page (upsert by stable id). */
  private async storeTruthVector(
    type: MemoryType,
    slug: string,
    vec: number[] | null,
  ): Promise<void> {
    if (!this.vectors || !vec) return
    this.vectors.insert(VECTOR_COLLECTION, truthVecId(type, slug), vec, {
      category: 'truth',
      scope: type,
      source_id: slug,
    })
  }

  private async indexTimelineEntry(
    type: MemoryType,
    _slug: string,
    timelineId: number,
    entry: string,
  ): Promise<void> {
    if (!this.vectors) return
    const embedding = await generateEmbedding(entry)
    if (!embedding) return
    this.vectors.insert(VECTOR_COLLECTION, timelineEntryId(timelineId), embedding, {
      category: 'timeline',
      scope: type,
      source_id: String(timelineId),
    })
  }

  // ---------------------------------------------------------------------------
  // Keyword search (two FTS indexes)
  // ---------------------------------------------------------------------------

  /** Truth FTS weight (BM25 column weighting). */
  private static readonly BM25_TRUTH_WEIGHT = 10.0
  /** Timeline FTS weight (lower than truth because less authoritative). */
  private static readonly BM25_TIMELINE_WEIGHT = 5.0

  searchPageFTS(query: string, types: MemoryType[] | undefined, limit: number): KeywordHit[] {
    const ftsQuery = buildFTS5Query(query)
    if (!ftsQuery) return []

    const clauses = ['memory_page_fts MATCH ?']
    const params: unknown[] = [ftsQuery]
    if (types && types.length > 0) {
      clauses.push(`p.type IN (${types.map(() => '?').join(',')})`)
      params.push(...types)
    }
    params.push(limit)

    const rows = this.db
      .prepare(
        `SELECT p.rowid AS row_id, p.type, p.slug,
                bm25(memory_page_fts, ?) AS bm25_score
           FROM memory_page_fts
           JOIN memory_page p ON p.rowid = memory_page_fts.rowid
          WHERE ${clauses.join(' AND ')}
          ORDER BY bm25_score ASC
          LIMIT ?`,
      )
      .all(MemoryEngine.BM25_TRUTH_WEIGHT, ...params) as Array<{
        row_id: number
        type: string
        slug: string
        bm25_score: number
      }>

    return rows
      .filter((r) => isMemoryType(r.type))
      .map((r) => ({
        source_type: 'truth' as const,
        page_type: r.type as MemoryType,
        page_slug: r.slug,
        row_id: r.row_id,
        score: normalizeBm25(r.bm25_score),
      }))
  }

  searchTimelineFTS(query: string, types: MemoryType[] | undefined, limit: number): KeywordHit[] {
    const ftsQuery = buildFTS5Query(query)
    if (!ftsQuery) return []

    const clauses = ['memory_timeline_fts MATCH ?']
    const params: unknown[] = [ftsQuery]
    if (types && types.length > 0) {
      clauses.push(`t.page_type IN (${types.map(() => '?').join(',')})`)
      params.push(...types)
    }
    params.push(limit)

    const rows = this.db
      .prepare(
        `SELECT t.id AS row_id, t.page_type, t.page_slug,
                bm25(memory_timeline_fts, ?) AS bm25_score
           FROM memory_timeline_fts
           JOIN memory_timeline t ON t.id = memory_timeline_fts.rowid
          WHERE ${clauses.join(' AND ')}
          ORDER BY bm25_score ASC
          LIMIT ?`,
      )
      .all(MemoryEngine.BM25_TIMELINE_WEIGHT, ...params) as Array<{
        row_id: number
        page_type: string
        page_slug: string
        bm25_score: number
      }>

    return rows
      .filter((r) => isMemoryType(r.page_type))
      .map((r) => ({
        source_type: 'timeline' as const,
        page_type: r.page_type as MemoryType,
        page_slug: r.page_slug,
        row_id: r.row_id,
        score: normalizeBm25(r.bm25_score),
      }))
  }

  // ---------------------------------------------------------------------------
  // Vector search
  // ---------------------------------------------------------------------------

  async searchVector(
    query: string,
    types: MemoryType[] | undefined,
    limit: number,
  ): Promise<VectorHit[]> {
    if (!this.vectors) return []
    const vec = await generateEmbedding(query)
    if (!vec) return []

    // vec0 pushes both `=` and `IN` on metadata columns down into the KNN
    // scan, so a multi-type restriction is applied *during* the scan. The old
    // backend could not be relied on for `IN`, which forced a widened candidate
    // window plus client-side filtering; neither is needed any more.
    const hits = this.vectors.search(
      VECTOR_COLLECTION,
      vec,
      limit,
      types && types.length > 0 ? { scope: types } : undefined,
    )

    const parsed: VectorHit[] = []
    for (const h of hits) {
      const v = this.parseVectorHit(h)
      if (!v) continue
      parsed.push(v)
      if (parsed.length >= limit) break
    }
    return parsed
  }

  private parseVectorHit(hit: VectorStoreHit): VectorHit | null {
    const category = String(hit.fields.category ?? '')
    const scope = String(hit.fields.scope ?? '')
    const sourceId = String(hit.fields.source_id ?? '')
    if (!category || !scope || !sourceId) return null
    if (!isMemoryType(scope)) return null

    if (category === 'truth') {
      return {
        source_type: 'truth',
        page_type: scope,
        page_slug: sourceId,
        distance: hit.score,
      }
    }
    if (category === 'timeline') {
      const timelineId = Number(sourceId)
      if (!Number.isFinite(timelineId)) return null
      const row = this.db
        .prepare('SELECT page_type, page_slug FROM memory_timeline WHERE id = ?')
        .get(timelineId) as { page_type: string; page_slug: string } | undefined
      if (!row || !isMemoryType(row.page_type)) return null
      return {
        source_type: 'timeline',
        page_type: row.page_type,
        page_slug: row.page_slug,
        timeline_id: timelineId,
        distance: hit.score,
      }
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // Mappers
  // ---------------------------------------------------------------------------

  private rowToPage(r: MemoryPageRow): MemoryPage {
    if (!isMemoryType(r.type)) throw new Error(`memory_page.type out of range: ${r.type}`)
    return {
      type: r.type,
      slug: r.slug,
      truth: r.truth,
      revision: r.revision,
      updated_at: r.updated_at,
    }
  }

  private rowToTimeline(r: MemoryTimelineRow): MemoryTimelineEntry {
    if (!isMemoryType(r.page_type)) {
      throw new Error(`memory_timeline.page_type out of range: ${r.page_type}`)
    }
    return {
      id: r.id,
      page_type: r.page_type,
      page_slug: r.page_slug,
      entry: r.entry,
      occurred_at: r.occurred_at,
      created_at: r.created_at,
    }
  }
}

// =============================================================================
// Vector-store id helpers
// =============================================================================

/**
 * Originally required because ZVec rejected doc_ids containing characters
 * outside its regex whitelist (e.g. `:`). vec0's TEXT primary key has no such
 * restriction, but the sanitisation is kept verbatim: these ids are persisted,
 * and changing the scheme would orphan every vector migrated out of the old
 * store. `__` stays the separator; the human-readable slug is still stored in
 * the `source_id` field for display and lookup.
 */
function safeIdPart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * Normalize a slug to an identity key for dedup: lowercase, collapse any run of
 * non-letter/number characters to a single dash, trim leading/trailing dashes.
 * Two slugs that differ only in case / separators / punctuation map to the same
 * key (e.g. "Alice Smith" / "alice-smith" / "alice_smith"), so they resolve to
 * the same page. Genuinely different slugs ("david-liu-meta" vs
 * "david-liu-crustdata") stay distinct.
 *
 * Unicode-aware (`\p{L}\p{N}`): non-ASCII names keep their letters instead of
 * collapsing to an empty key, so CJK / accented identities ("大卫", "José") are
 * real keys and can carry aliases. ASCII behaviour is unchanged.
 */
export function normalizeSlugKey(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/** Stable per-page id for the single whole-truth vector. */
export function truthVecId(type: MemoryType, slug: string): string {
  return `truth__${safeIdPart(type)}__${safeIdPart(slug)}`
}

export function timelineEntryId(id: number): string {
  return `timeline__${id}`
}

// =============================================================================
// FTS5 helpers (ported from old vector/hybrid-search + memory-storage)
// =============================================================================

function sanitizeFTS5Term(term: string): string {
  return term.replace(/[^\p{L}\p{N}']/gu, '').toLowerCase()
}

/**
 * Supports quoted phrases, `-negation`, and prefix match on bare tokens.
 * Returns null when no usable terms.
 */
export function buildFTS5Query(query: string): string | null {
  const positive: string[] = []
  const negative: string[] = []

  const s = query
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++
    if (i >= s.length) break

    let negated = false
    if (s[i] === '-') {
      negated = true
      i++
    }

    if (s[i] === '"') {
      const closeQuote = s.indexOf('"', i + 1)
      if (closeQuote === -1) break
      const phrase = s.slice(i + 1, closeQuote).trim()
      i = closeQuote + 1
      if (phrase.length > 0) {
        const sanitized = phrase
          .split(/\s+/)
          .map((t) => sanitizeFTS5Term(t))
          .filter((t) => t)
          .join(' ')
        if (sanitized) {
          const ftsPhrase = `"${sanitized}"`
          if (negated) negative.push(ftsPhrase)
          else positive.push(ftsPhrase)
        }
      }
    } else {
      const start = i
      while (i < s.length && !/[\s"]/.test(s[i]!)) i++
      const term = s.slice(start, i)
      const sanitized = sanitizeFTS5Term(term)
      if (sanitized) {
        const ftsTerm = `"${sanitized}"*`
        if (negated) negative.push(ftsTerm)
        else positive.push(ftsTerm)
      }
    }
  }

  if (positive.length === 0 && negative.length === 0) return null

  let result = positive.join(' OR ')
  if (negative.length > 0) {
    result =
      positive.length > 0
        ? `(${result}) NOT (${negative.join(' OR ')})`
        : `NOT (${negative.join(' OR ')})`
  }
  return result || null
}

/** SQLite BM25 is negative (lower=better). Map to (0,1), higher=better. */
export function normalizeBm25(bm25: number): number {
  const abs = Math.abs(bm25)
  return abs / (1 + abs)
}

// =============================================================================
// Type guards
// =============================================================================

function isMemoryType(v: string): v is MemoryType {
  return (MEMORY_TYPES as string[]).includes(v)
}
