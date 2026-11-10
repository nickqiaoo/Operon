/**
 * Memory operations — the 2-tool agent surface: search (read) + upsert (write).
 *
 * Point reads (memory_get) and timeline pagination (memory_timeline) were
 * deliberately removed from the agent surface — search already returns truth +
 * recent timeline, and fewer overlapping read tools means fewer mis-selections.
 * The underlying engine methods (getPage / pageTimeline) stay for the REST
 * route + background code.
 *
 * Live agents reach these via the memory MCP server (`routes/memory-mcp.ts`,
 * mounted at /api/memory-mcp), and the background extractor reaches them the
 * same way through its headless session. Both dispatch to the exec* functions
 * below.
 */

import type { MemoryEngine, MemoryReadFilter } from './engine.js'
import {
  MemoryPageExistsError,
  MemoryPageNotFoundError,
  MemoryRevisionConflictError,
  normalizeSlugKey,
} from './engine.js'
import { memoryBrowse, memorySearch } from './search/hybrid.js'
import {
  MEMORY_TYPES,
  SINGLETON_SLUG,
  SINGLETON_TYPES,
  WRITABLE_MEMORY_TYPES,
  type MemoryPageResult,
  type MemoryType,
  type TimelineInput,
} from './types.js'

function j(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** Epoch-ms → model-facing date (YYYY-MM-DD, UTC), or null when the time is unknown. */
function dateOrNull(ms: number | null | undefined): string | null {
  if (ms == null) return null
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/**
 * Parse a model-supplied date (`occurred_at`, `since`, `until`) into epoch ms at
 * UTC midnight (day-level), or undefined when unset. The tool surface takes a date
 * string ("2025-07-16") so the model never hand-computes epoch ms; a leading date
 * inside a fuller ISO string is accepted (time is floored away), and a raw epoch
 * number still passes through for backward compatibility. This mirrors the
 * day-level read format.
 */
function parseDate(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${field} must be a valid date`)
    return value
  }
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a date string like "2025-07-16"`)
  }
  const s = value.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) throw new Error(`${field} must be a date like "2025-07-16", got "${s}"`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new Error(`${field} is not a real calendar date: "${s}"`)
  }
  return dt.getTime()
}

const DAY_MS = 86_400_000

/** Most timeline entries one page returns to the model per search. */
const TIMELINE_PER_PAGE = 5

/**
 * Pick the entries a page shows the model. Entries are ranked by relevance to the
 * query, except when the query only names the page: then nearly every entry
 * matches and relevance says nothing, so the newest win. Ties keep newest first
 * (`r.timeline` arrives that way), and the kept entries stay in time order.
 */
export function selectTimelineForModel(
  query: string,
  r: Pick<MemoryPageResult, 'slug' | 'timeline'>,
): { timeline: MemoryPageResult['timeline']; omitted: number } {
  const queryIsPageName = normalizeSlugKey(query) === normalizeSlugKey(r.slug)
  const ranked = queryIsPageName
    ? r.timeline
    : [...r.timeline].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
  const kept = new Set(ranked.slice(0, TIMELINE_PER_PAGE).map((t) => t.id))
  return {
    timeline: r.timeline.filter((t) => kept.has(t.id)),
    omitted: r.timeline.length - kept.size,
  }
}

/**
 * Shape memory_search results for the tool text the model reads. A bare epoch-ms
 * integer (e.g. 1752662400000) is meaningless to an LLM, so serialize the
 * business/write times as day-level dates (YYYY-MM-DD, UTC) — the same UTC frame
 * the extractor uses when it resolves relative dates into occurred_at, and
 * symmetric with the date string memory_upsert accepts. The REST /search route
 * keeps the raw numeric fields for the settings UI (formatDate); this transform
 * is only for the model-facing tool call.
 */
function formatSearchResultsForModel(results: MemoryPageResult[], query: string): unknown {
  return results.map((r) => {
    const { timeline, omitted } = selectTimelineForModel(query, r)
    return {
      type: r.type,
      slug: r.slug,
      truth: r.truth,
      revision: r.revision,
      updated_at: dateOrNull(r.updated_at),
      timeline: timeline.map((t) => ({
        id: t.id,
        occurred_at: dateOrNull(t.occurred_at),
        entry: t.entry,
        matched: t.matched,
      })),
      ...(omitted > 0 ? { timeline_omitted: omitted } : {}),
    }
  })
}

function parseType(value: unknown): MemoryType {
  if (typeof value !== 'string' || !(MEMORY_TYPES as string[]).includes(value)) {
    throw new Error(`type must be one of: ${MEMORY_TYPES.join(', ')}`)
  }
  return value as MemoryType
}

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------

export async function execMemorySearch(
  engine: MemoryEngine,
  args: {
    query?: string
    types?: unknown
    type?: unknown
    limit?: number
    /** Inclusive first day, "YYYY-MM-DD" (UTC). */
    since?: string | number
    /** Inclusive last day, "YYYY-MM-DD" (UTC). */
    until?: string | number
    slug?: string
  },
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  const slug = typeof args.slug === 'string' ? args.slug.trim() : ''
  const since = parseDate(args.since, 'since')
  const untilDay = parseDate(args.until, 'until')
  if (!query && !slug && since === undefined && untilDay === undefined) {
    throw new Error('query is required unless since, until or slug is given')
  }
  // Dates are day-level, so the last day counts through its final millisecond.
  const until = untilDay === undefined ? undefined : untilDay + DAY_MS - 1
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error('since must not be after until')
  }

  const types = parseTypes(args.types ?? args.type)
  const filter: MemoryReadFilter = { since, until }
  if (slug) {
    filter.pages = resolvePages(engine, slug, types)
    if (filter.pages.length === 0) return 'No matching memory pages.'
  }

  const results = query
    ? await memorySearch(engine, query, { types, limit: args.limit, filter })
    : memoryBrowse(engine, { types, limit: args.limit, filter })
  if (results.length === 0) return 'No matching memory pages.'
  return j(formatSearchResultsForModel(results, query))
}

/** The existing pages a slug names, in each of `types` (all types when unset). */
function resolvePages(
  engine: MemoryEngine,
  slug: string,
  types: MemoryType[] | undefined,
): Array<{ type: MemoryType; slug: string }> {
  return (types ?? MEMORY_TYPES).flatMap((type) => {
    const resolved = engine.resolveExistingSlug(type, slug)
    return resolved ? [{ type, slug: resolved }] : []
  })
}

function parseTypes(value: unknown): MemoryType[] | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return [parseType(value)]
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined
    return value.map(parseType)
  }
  throw new Error('types must be a string or an array of strings')
}

// ---------------------------------------------------------------------------
// memory_upsert
// ---------------------------------------------------------------------------

/**
 * Write-time reconcile threshold (cosine distance, lower = more similar):
 *   ≤ RECONCILE → possible same page → return `needs_reconcile`
 *   > RECONCILE → clearly new enough → create a fresh page
 *
 * Important: vector similarity only finds candidate identity. It never proves
 * the incoming content is a full replacement for an existing page's truth.
 */
const RECONCILE_DISTANCE = 0.35
const CANDIDATE_K = 5

interface MergeDecision {
  action: 'merge'
  target_slug: string
  /** Required when `truth` is present. */
  base_revision?: number
  /** Full new page truth. Omitted = append to the timeline, truth unchanged. */
  truth?: string
}

interface CreateDecision {
  action: 'create'
}

type ReconcileDecision = MergeDecision | CreateDecision

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parseDecision(value: unknown): ReconcileDecision | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('decision must be an object')

  const action = value.action
  if (action !== 'merge' && action !== 'create') {
    throw new Error('decision.action must be "merge" or "create"')
  }

  if (action === 'merge') {
    const targetSlug = optionalString(value.target_slug)?.trim()
    const truth = optionalString(value.truth)?.trim()
    const baseRevision = value.base_revision
    if (!targetSlug) throw new Error('decision.target_slug is required for merge')
    if (!truth) return { action, target_slug: targetSlug }
    if (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision)) {
      throw new Error('decision.base_revision is required when merge rewrites truth')
    }
    return {
      action,
      target_slug: targetSlug,
      base_revision: baseRevision,
      truth,
    }
  }

  return { action }
}

export async function execMemoryUpsert(
  engine: MemoryEngine,
  args: {
    type: string
	    slug_hint?: string
	    slug?: string
	    /** New fact / observation to remember. First-call input, not full page truth. */
	    content?: string
	    /** Why this memory write is being attempted. */
	    reason?: string
	    /** When the fact/event happened, as a date string ("2025-07-16", UTC). Epoch ms still accepted. */
	    occurred_at?: string | number
	    /** Second-call decision after a needs_reconcile response. */
	    decision?: unknown
	  },
  ctx: MemoryToolContext = {},
): Promise<string> {
  const type = parseType(args.type)
  if (!WRITABLE_MEMORY_TYPES.includes(type)) {
    throw new Error(
      `type "${type}" is read-only. Add this to the timeline of the person, project or thing it happened to, using entities or user.`,
    )
  }
  const rawHint = args.slug_hint ?? args.slug ?? ''
  const hint = SINGLETON_TYPES.has(type) ? SINGLETON_SLUG : String(rawHint).trim()

	  const content = (args.content ?? '').trim()
	  if (!content) {
	    throw new Error('content is required')
	  }
	  const reason = (args.reason ?? '').trim()
	  if (!reason) {
	    throw new Error('reason is required — every memory write must be explained')
	  }

	  // The timeline records WHAT was learned (the incoming content); the reason is
	  // the evidence behind it and is kept beside the entry, not as the entry —
	  // otherwise the history reads as a list of "worth remembering because…".
	  const timeline: TimelineInput = {
	    entry: content,
	    reason,
	    source: ctx.source,
	    occurred_at: parseDate(args.occurred_at, 'occurred_at'),
	  }

  if (!hint) throw new Error('slug_hint is required for this type')
  const decision = parseDecision(args.decision)

  if (decision?.action === 'merge') {
    const targetSlug = engine.resolveExistingSlug(type, decision.target_slug)
    const targetPage = targetSlug ? engine.getPage(type, targetSlug) : null
    if (!targetPage) {
      return j({
        status: 'conflict',
        reason: 'target_not_found',
        type,
        slug_hint: hint,
        target_slug: decision.target_slug,
      })
    }

    try {
      if (decision.truth === undefined) {
        const appended = await engine.appendTimeline(type, targetPage.slug, timeline)
        if (hint) engine.recordAlias(type, hint, appended.slug)
        return j({ status: 'written', action: 'appended', ...appended })
      }

      const result = await engine.replacePageTruth(type, targetPage.slug, decision.truth, timeline, {
        baseRevision: decision.base_revision,
        reuseLatestEntry: true,
      })
      if (hint) engine.recordAlias(type, hint, result.slug)
      return j({ status: 'written', action: 'merged', ...result })
    } catch (err) {
      if (err instanceof MemoryRevisionConflictError) {
        return j({
          status: 'conflict',
          reason: 'revision_mismatch',
          type,
          slug_hint: hint,
          candidate: {
            slug: err.page.slug,
            truth: err.page.truth,
            revision: err.page.revision,
          },
        })
      }
      if (err instanceof MemoryPageNotFoundError) {
        return j({
          status: 'conflict',
          reason: 'target_not_found',
          type,
          slug_hint: hint,
          target_slug: err.slug,
        })
      }
      throw err
    }
  }

  if (decision?.action === 'create') {
    const existingSlug = engine.resolveExistingSlug(type, hint)
    const existingPage = existingSlug ? engine.getPage(type, existingSlug) : null
    if (existingPage) {
      return needsReconcile(type, hint, content, reason, [
        {
          slug: existingPage.slug,
          truth: existingPage.truth,
          revision: existingPage.revision,
          match: 'identity',
        },
      ])
    }

    try {
      const result = await engine.createPage(type, hint, content, timeline)
      return j({ status: 'written', action: 'created', ...result })
    } catch (err) {
      if (err instanceof MemoryPageExistsError) {
        return needsReconcile(type, hint, content, reason, [
          {
            slug: err.page.slug,
            truth: err.page.truth,
            revision: err.page.revision,
            match: 'identity',
          },
        ])
      }
      throw err
    }
  }

  // First call: never replace an existing truth. A hint that names a page
  // appends straight to its timeline, the usual and non-destructive outcome.
  // An alias or a semantic candidate may be the wrong page, so those go back to
  // the running agent.
  const existingSlug = engine.resolveExistingSlug(type, hint)
  const existingPage = existingSlug ? engine.getPage(type, existingSlug) : null
  if (existingPage && normalizeSlugKey(existingPage.slug) === normalizeSlugKey(hint)) {
    const appended = await engine.appendTimeline(type, existingPage.slug, timeline)
    return j({
      status: 'written',
      action: 'appended',
      ...appended,
      truth: existingPage.truth,
      instruction:
        'Added to this page\'s timeline; the truth is unchanged and that is usually right. ' +
        'Only if the truth has become wrong or lacks a lasting fact, re-call memory_upsert with the same content/reason and ' +
        'decision={action:"merge",target_slug,base_revision,truth}. The timeline entry will not be duplicated.',
    })
  }
  if (existingPage) {
    return needsReconcile(type, hint, content, reason, [
      {
        slug: existingPage.slug,
        truth: existingPage.truth,
        revision: existingPage.revision,
        match: 'identity',
      },
    ])
  }

  const candidates = await engine.findDuplicateCandidates(type, content, CANDIDATE_K)
  const nearest = candidates[0]

  if (nearest && nearest.distance <= RECONCILE_DISTANCE) {
    return needsReconcile(
      type,
      hint,
      content,
      reason,
      candidates
        .filter((c) => c.distance <= RECONCILE_DISTANCE)
        .map((c) => ({
          slug: c.slug,
          truth: c.truth,
          revision: c.revision,
          distance: Number(c.distance.toFixed(3)),
          match: 'semantic' as const,
        })),
    )
  }

  // No existing identity and no close semantic candidate: create a fresh page
  // whose first canonical truth is the incoming content.
  const result = await engine.createPage(type, hint, content, timeline)
  return j({ status: 'written', action: 'created', ...result })
}

/** Caller-side facts about a write that the model does not (and should not) supply. */
export interface MemoryToolContext {
  /** Where the write came from, e.g. "chat:123" — recorded on the timeline entry. */
  source?: string
}

type ReconcileCandidate = {
  slug: string
  truth: string
  revision: number
  distance?: number
  match: 'identity' | 'semantic'
}

function needsReconcile(
  type: MemoryType,
  slugHint: string,
  content: string,
  reason: string,
  candidates: ReconcileCandidate[],
): string {
  return j({
    status: 'needs_reconcile',
    type,
    slug_hint: slugHint,
    incoming: { content, reason },
    candidates,
    instruction:
      'Decide whether the incoming content belongs on an existing page or should become a new page. ' +
      'Re-call memory_upsert with the same content/reason and one decision: ' +
      'decision={action:"merge",target_slug} appends it to that page\'s timeline and leaves the truth unchanged (the usual case); ' +
      'decision={action:"merge",target_slug,base_revision,truth} also replaces the truth, only when it has become wrong or lacks a lasting fact; ' +
      'decision={action:"create"} makes a genuinely new page.',
  })
}

// There is no separate merge tool. `execMemoryUpsert` is a two-step state
// machine: first call surfaces duplicate candidates; the running agent then
// re-calls the same tool with a decision to merge or create.

// ---------------------------------------------------------------------------
// MCP tool manifest
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>

export interface MemoryMcpTool {
  name: string
  description: string
  inputSchema: JsonSchema
}

export const MEMORY_MCP_TOOLS: MemoryMcpTool[] = [
  {
    name: 'memory_search',
    description:
      'Hybrid retrieval across memory pages (truth + timeline). Fuses FTS5 and vector search, grouped by (type, slug). Pass multiple types in one call to avoid repeated searches. Each page returns its full truth and at most 5 timeline entries (the most relevant, shown newest first); timeline_omitted counts other entries that matched, so refine the query or narrow the dates to reach them. since, until and slug are exact filters: with any of them query is optional, and without a query entries are listed newest first. With since or until, only timeline entries in that range count as matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Space-separated keywords (words of 3+ characters match best) or natural language. Optional when since, until or slug is given.',
        },
        since: {
          type: 'string',
          description: 'Only timeline entries on or after this day, "YYYY-MM-DD" (UTC).',
        },
        until: {
          type: 'string',
          description: 'Only timeline entries on or before this day, "YYYY-MM-DD" (UTC).',
        },
        slug: {
          type: 'string',
          description: 'Only this page, by its slug.',
        },
        types: {
          type: 'array',
          items: { type: 'string', enum: MEMORY_TYPES },
          description:
            'Optional memory type filter. Pass multiple to search across several types in a single call. Omit or pass an empty array for all types.',
        },
        limit: {
          type: 'number',
          description: 'Max number of pages to return (default 10).',
        },
      },
    },
  },
  {
    name: 'memory_upsert',
    description:
      'Write memory. Call with type, slug_hint, content, and reason. If slug_hint names an existing page, the content is appended to its timeline and the current truth and revision are returned. If nothing similar exists, a page is created. If the name is an alias or a similar page exists, it writes nothing and returns {status:"needs_reconcile", incoming, candidates:[{slug,truth,revision,distance?,match}]}: re-call with the same content/reason and one decision. {action:"merge",target_slug} appends the content to that page\'s timeline and leaves its truth unchanged (the usual case); {action:"merge",target_slug,base_revision,truth} also replaces the truth, only when it has become wrong or lacks a lasting fact; {action:"create"} creates a genuinely new page. Type "user" ignores slug_hint and uses slug "user".',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: WRITABLE_MEMORY_TYPES,
          description:
            'user: the person and their standing preferences across projects (one page). entities: a named person, organization, product / project, service, account, device or server (one page per project, never per module); dated facts go on the timeline of the page they happened to. cases: a hard-won lesson the repo cannot tell a future session, or a reusable playbook.',
        },
        slug_hint: {
          type: 'string',
          description:
            'Required for entities and cases; ignored for user. The page name, by STABLE identity (canonical name / id / key), never by what happened.',
        },
        content: {
          type: 'string',
          description:
            'The new fact / observation / change, stated on its own (what happened, or old → new). It is recorded as the timeline entry, so make it readable without the conversation. On the first call this is not the full page truth.',
        },
        reason: {
          type: 'string',
          description:
            "Evidence for the write: quote the user's own words that establish it (e.g. 'User: \"always use pnpm\"'), or for a case the observation that proves it. Not a value judgement like \"useful later\". Stored beside the entry for audit, not searched.",
        },
        occurred_at: {
          type: 'string',
          description:
            'When the fact/event actually happened (business time) as a date string "YYYY-MM-DD" (UTC) — NOT when you are writing it. Set it for anything dated, resolving relative references against the conversation date. Omit ONLY if the time is genuinely unknown: it is then recorded as unknown (NULL), never silently set to "now".',
        },
        decision: {
          type: 'object',
          description:
            'Pass after a needs_reconcile response, or after a write that returned a truth which must now change. action="merge" with target_slug appends to the timeline and keeps the truth; add base_revision and truth only when the truth must change. action="create" makes a genuinely new page.',
          properties: {
            action: { type: 'string', enum: ['merge', 'create'] },
            target_slug: { type: 'string' },
            base_revision: { type: 'number' },
            truth: {
              type: 'string',
              description:
                'The full new truth: what is true now, as one opening line then a handful of "-" bullets, one fact each. Condense when rewriting and never concatenate the new fact onto the old text. No dates unless the date is the fact; history belongs in the timeline.',
            },
          },
        },
      },
      required: ['type', 'content', 'reason'],
    },
  },
]

// ---------------------------------------------------------------------------
// Central dispatch (MCP route)
// ---------------------------------------------------------------------------

export async function dispatchMemoryTool(
  engine: MemoryEngine,
  name: string,
  args: Record<string, unknown>,
  ctx: MemoryToolContext = {},
): Promise<string> {
  switch (name) {
    case 'memory_search':
      return execMemorySearch(engine, args as Parameters<typeof execMemorySearch>[1])
    case 'memory_upsert':
      return execMemoryUpsert(engine, args as Parameters<typeof execMemoryUpsert>[1], ctx)
    default:
      throw new Error(`Unknown memory tool: ${name}`)
  }
}
