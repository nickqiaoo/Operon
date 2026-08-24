/**
 * In-process memory tools for the operon (`custom`) extraction provider.
 *
 * CLI providers (claude/codex/gemini/kimi) receive `memory_search`/`memory_upsert`
 * by spawning the memory MCP server (buildMcpServersForCli). The `custom` provider
 * runs the in-process `operon-agents` harness, which has no MCP wiring — so without
 * this its extraction agent has NO memory tools and writes nothing.
 *
 * These are operon-agents `tool()`s that dispatch straight to the same
 * `dispatchMemoryTool` the MCP server uses, against the sandboxed engine. The bench
 * adapter registers them via `registerOperonRuntimeTools` before extraction runs.
 * The Zod params mirror MEMORY_MCP_TOOLS' JSON schemas so the model sees the same
 * contract; `dispatchMemoryTool` still does its own validation downstream.
 */

import { tool, type Tool } from 'operon-agents'
import { z } from 'zod'
import { MEMORY_TYPES } from '../src/services/memory/types.js'
import { MEMORY_MCP_TOOLS, dispatchMemoryTool } from '../src/services/memory/operations.js'
import type { MemoryEngine } from '../src/services/memory/engine.js'

// Lenient param shapes. operon validates tool args against these BEFORE execute;
// a hard schema rejection surfaces as a whole-turn error ("message error") rather
// than a soft, recoverable tool result. Weaker/looser models emit imperfect args
// (e.g. step-3 sends `types` as a JSON-stringified array, or a hallucinated type
// like "reflections"). So we accept loosely here and let dispatchMemoryTool / the
// engine validate downstream and return a soft error the agent can recover from.
// MEMORY_TYPES still drives the description so models see the intended set.
const typeParam = z.string().describe(`One of: ${MEMORY_TYPES.join(', ')}.`)
const typesParam = z
  .preprocess((v) => {
    if (typeof v === 'string') {
      const s = v.trim()
      if (s.startsWith('[')) {
        try {
          return JSON.parse(s) as unknown
        } catch {
          return [s]
        }
      }
      return s ? [s] : undefined
    }
    return v
  }, z.array(z.string()).optional())
  .describe(`Optional memory type filter (subset of: ${MEMORY_TYPES.join(', ')}). Omit for all types.`)

/** Description from the canonical MCP tool list, so both surfaces stay identical. */
function desc(name: string): string {
  const t = MEMORY_MCP_TOOLS.find((m) => m.name === name)
  if (!t) throw new Error(`memory tool "${name}" missing from MEMORY_MCP_TOOLS`)
  return t.description
}

interface ReconcileResult {
  status?: string
  type?: string
  candidates?: Array<{ slug?: string; truth?: string; revision?: number; match?: string }>
}

/**
 * Reconcile scaffolding for weak extraction models (bench-only, "Fix C").
 *
 * The engine's `needs_reconcile` reply hands the agent a list of candidates and a
 * GENERIC instruction ("re-call with decision={...,target_slug,base_revision,...}"),
 * leaving the agent to pick the right candidate slug + revision. Strong models do
 * this fine; weak ones (e.g. step-3.7-flash) instead re-send the IDENTICAL upsert
 * and loop forever. We do NOT take the decision away from the agent — we just append
 * an explicit, values-filled next step (the concrete target_slug + base_revision of
 * the closest candidate) so even a weak model can comply. The merge-vs-create choice,
 * and the merged truth, are still the agent's.
 */
function scaffoldReconcile(raw: string): string {
  let parsed: ReconcileResult
  try {
    parsed = JSON.parse(raw) as ReconcileResult
  } catch {
    return raw
  }
  if (parsed.status !== 'needs_reconcile') return raw
  const candidates = parsed.candidates ?? []
  const top = candidates[0]
  if (!top?.slug || typeof top.revision !== 'number') return raw

  const lines = [
    raw,
    '',
    '=== NEXT STEP — decide now; do NOT resend this same call unchanged ===',
    `Closest existing page: target_slug="${top.slug}"  base_revision=${top.revision}  (match=${top.match ?? 'semantic'})`,
    `Its current truth: ${top.truth ?? ''}`,
    '',
    'If your new content belongs on that SAME page, call memory_upsert again with EXACTLY:',
    `  type="${parsed.type ?? ''}", content=<same content>, reason=<same reason>,`,
    `  decision={"action":"merge","target_slug":"${top.slug}","base_revision":${top.revision},"truth":"<the truth above, rewritten to also include your new content>"}`,
    '',
    'If it is genuinely a DIFFERENT page, call memory_upsert again with:',
    '  decision={"action":"create"}',
  ]
  if (candidates.length > 1) {
    lines.push(
      '',
      `(${candidates.length - 1} other candidate(s) listed above — if a different one is the real match, use ITS slug/revision instead.)`,
    )
  }
  return lines.join('\n')
}

export function buildOperonMemoryTools(engine: MemoryEngine): Tool[] {
  const search = tool({
    name: 'memory_search',
    description: desc('memory_search'),
    parameters: z.object({
      query: z.string().describe('Natural-language or keyword query.'),
      types: typesParam,
      limit: z.number().optional().describe('Max number of pages to return (default 10).'),
    }),
    execute: async (args) =>
      dispatchMemoryTool(engine, 'memory_search', args as Record<string, unknown>),
  })

  const upsert = tool({
    name: 'memory_upsert',
    description: desc('memory_upsert'),
    parameters: z.object({
      type: typeParam,
      slug_hint: z
        .string()
        .optional()
        .describe('Caller-proposed slug, by STABLE identity. Ignored for singleton types.'),
      content: z.string().describe('New fact or observation to remember.'),
      reason: z.string().describe('Why this memory should be written.'),
      occurred_at: z
        .string()
        .optional()
        .describe(
          'When the fact/event actually happened (business time) as a date string "YYYY-MM-DD" (UTC) — NOT the write time. Set it for anything dated; omit ONLY if truly unknown (then recorded as NULL, never "now").',
        ),
      decision: z
        .object({
          action: z.enum(['merge', 'create']),
          target_slug: z.string().optional(),
          base_revision: z.number().optional(),
          truth: z.string().optional(),
        })
        .optional()
        .describe('Only pass after a needs_reconcile response.'),
    }),
    execute: async (args) =>
      scaffoldReconcile(await dispatchMemoryTool(engine, 'memory_upsert', args as Record<string, unknown>)),
  })

  return [search, upsert]
}
