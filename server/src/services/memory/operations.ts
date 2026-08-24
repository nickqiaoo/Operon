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

import type { MemoryEngine } from './engine.js'
import {
  MemoryPageExistsError,
  MemoryPageNotFoundError,
  MemoryRevisionConflictError,
} from './engine.js'
import { memorySearch } from './search/hybrid.js'
import {
  MEMORY_TYPES,
  SINGLETON_SLUG,
  SINGLETON_TYPES,
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
 * Parse a model-supplied `occurred_at` into epoch ms at UTC midnight (day-level),
 * or undefined when unset. The tool surface takes a date string ("2025-07-16") so
 * the model never hand-computes epoch ms; a leading date inside a fuller ISO
 * string is accepted (time is floored away), and a raw epoch number still passes
 * through for backward compatibility. This mirrors the day-level read format.
 */
function parseOccurredAt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('occurred_at must be a valid date')
    return value
  }
  if (typeof value !== 'string') {
    throw new Error('occurred_at must be a date string like "2025-07-16"')
  }
  const s = value.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) throw new Error(`occurred_at must be a date like "2025-07-16", got "${s}"`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new Error(`occurred_at is not a real calendar date: "${s}"`)
  }
  return dt.getTime()
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
function formatSearchResultsForModel(results: MemoryPageResult[]): unknown {
  return results.map((r) => ({
    type: r.type,
    slug: r.slug,
    truth: r.truth,
    revision: r.revision,
    updated_at: dateOrNull(r.updated_at),
    timeline: r.timeline.map((t) => ({
      id: t.id,
      occurred_at: dateOrNull(t.occurred_at),
      entry: t.entry,
      matched: t.matched,
    })),
  }))
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
  args: { query: string; types?: unknown; type?: unknown; limit?: number },
): Promise<string> {
  if (!args.query || typeof args.query !== 'string') {
    throw new Error('query is required')
  }
  const types = parseTypes(args.types ?? args.type)
  const results = await memorySearch(engine, args.query, {
    types,
    limit: args.limit,
  })
  if (results.length === 0) return 'No matching memory pages.'
  return j(formatSearchResultsForModel(results))
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
  base_revision: number
  truth: string
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
    if (!truth) throw new Error('decision.truth is required for merge')
    if (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision)) {
      throw new Error('decision.base_revision is required for merge')
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
): Promise<string> {
  const type = parseType(args.type)
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

	  const timeline: TimelineInput = {
	    entry: reason,
	    occurred_at: parseOccurredAt(args.occurred_at),
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
      const result = await engine.replacePageTruth(type, targetPage.slug, decision.truth, timeline, {
        baseRevision: decision.base_revision,
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

  // First call: never replace an existing page. If a deterministic identity or
  // semantic candidate exists, hand the choice back to the running agent.
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
      'Re-call memory_upsert with the same content/reason and decision={action:"merge",target_slug,base_revision,truth} ' +
      'where truth is the full merged page truth, or decision={action:"create"} for a genuinely new page.',
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
      'Hybrid retrieval across memory pages (truth + timeline). Fuses FTS5 and vector search, grouped by (type, slug). Pass multiple types in one call to avoid repeated searches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query.' },
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
      required: ['query'],
    },
  },
  {
    name: 'memory_upsert',
    description:
      'Write memory through a two-step reconcile flow. First call with type, slug_hint, content, and reason. If no existing identity or semantic candidate is found, it creates a page. If candidates exist, it returns {status:"needs_reconcile", incoming, candidates:[{slug,truth,revision,distance?,match}]}. Re-call with the same content/reason and decision={action:"merge",target_slug,base_revision,truth} to replace the target with a full merged page truth, or decision={action:"create"} to create a genuinely new page. Type "user" ignores slug_hint and uses slug "user".',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: MEMORY_TYPES },
        slug_hint: {
          type: 'string',
          description:
            'Caller-proposed slug, by STABLE identity (canonical name / id / key), never by what happened. Ignored for the singleton "user" type.',
        },
        content: {
          type: 'string',
          description:
            'New fact or observation to remember. On the first call this is not the full page truth.',
        },
        reason: {
          type: 'string',
          description: 'Why this memory should be written.',
        },
        occurred_at: {
          type: 'string',
          description:
            'When the fact/event actually happened (business time) as a date string "YYYY-MM-DD" (UTC) — NOT when you are writing it. Set it for anything dated, resolving relative references against the conversation date. Omit ONLY if the time is genuinely unknown: it is then recorded as unknown (NULL), never silently set to "now".',
        },
        decision: {
          type: 'object',
          description:
            'Only pass after a needs_reconcile response. Use action="merge" with target_slug, base_revision, and full merged truth, or action="create" for a genuinely new page.',
          properties: {
            action: { type: 'string', enum: ['merge', 'create'] },
            target_slug: { type: 'string' },
            base_revision: { type: 'number' },
            truth: { type: 'string' },
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
): Promise<string> {
  switch (name) {
    case 'memory_search':
      return execMemorySearch(engine, args as Parameters<typeof execMemorySearch>[1])
    case 'memory_upsert':
      return execMemoryUpsert(engine, args as Parameters<typeof execMemoryUpsert>[1])
    default:
      throw new Error(`Unknown memory tool: ${name}`)
  }
}
