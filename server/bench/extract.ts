/**
 * Benchmark extraction — Layer 1, REAL-agent edition.
 *
 * The real xui product extracts memories with a daily scheduled job
 * (memory-maintenance/scheduler.ts -> runExtractor -> runHeadlessMemoryAgent).
 * `runExtractor` is coupled to the chat tables (watermarks, 24h-recency filter),
 * but `runHeadlessMemoryAgent` — the actual agent driver — takes an arbitrary
 * `{systemPrompt, messages}` and goes through the provider's normal session
 * construction (including MCP memory-tool injection). So we drive extraction with
 * THAT, exactly as production does: same system prompt (`buildExtractSystemPrompt`),
 * same agent runtime, same memory tools, same engine.
 *
 * Isolation: the agent's memory_* tools dispatch to
 * `MemoryService.getInstance().getEngine()`. The adapter calls `MemoryService.init`
 * with the sandboxed db, so every write lands in the sandbox (see adapter.ts).
 *
 * The ONLY thing that differs between the two benchmark numbers is the system
 * prompt's value gate (BENCH_EXTRACT_PROFILE) — the driver, model, tools, engine
 * and storage model are identical.
 *
 * Config (env):
 *   BENCH_PROVIDER_ID            required — which agent runtime drives extraction
 *                                (claude | codex | gemini | kimi | opencode |
 *                                 cursor | copilot | custom). Its CLI must be
 *                                available + authed in this environment.
 *   BENCH_EXTRACT_MODEL          optional — model id for the agent; unset = agent default
 *   BENCH_EXTRACT_CWD            optional — agent working dir (default process.cwd())
 *   BENCH_EXTRACT_CHUNK_TURNS    default 30 (turns per extraction chunk)
 *   BENCH_EXTRACT_PROFILE        product (default) | high-recall
 *     product     — xui's real value-gated extractor. Honest product number.
 *     high-recall — same agent / prompt / model / tools / engine, but the value
 *                   gate is suspended so coverage matches mem0's "when in doubt,
 *                   extract" philosophy. Isolates ARCHITECTURE from the value
 *                   gate's coverage penalty. NOT a different driver — the ONLY
 *                   difference from `product` is the prompt's value gate.
 *
 * Comparing to mem0: since extraction now runs on the agent's own model (e.g.
 * Claude), run mem0's extraction at the SAME model for a fair comparison rather
 * than citing mem0's published gpt-4o-mini numbers.
 */

import { buildExtractSystemPrompt } from '../src/services/memory-maintenance/prompt.js'
import { runHeadlessMemoryAgent } from '../src/services/memory-maintenance/headless.js'

const PROVIDER_ID = process.env.BENCH_PROVIDER_ID || ''
const MODEL = process.env.BENCH_EXTRACT_MODEL || undefined
const CWD = process.env.BENCH_EXTRACT_CWD || process.cwd()
export const CHUNK_TURNS = Number(process.env.BENCH_EXTRACT_CHUNK_TURNS || 30)

// Extraction coverage profile. 'product' = xui's real value-gated extractor;
// 'high-recall' = same agent with the value gate lifted (mem0-comparable
// coverage). See the file header and server/bench/README.md.
export const EXTRACT_PROFILE = (process.env.BENCH_EXTRACT_PROFILE || 'high-recall').toLowerCase()

// Appended ONLY in high-recall mode. Suspends the value gate while keeping every
// structural rule (slug-by-identity, search-before-upsert, reason,
// old→new transitions), so we still benchmark xui's memory model — just at
// mem0-comparable coverage. The override quotes the exact gate rules it lifts
// (recency + specificity) so it reliably wins.
const HIGH_RECALL_OVERRIDE = `=== HIGH-RECALL OVERRIDE (benchmark coverage profile — overrides any conflicting rule above) ===

The value gate above is SUSPENDED for this run. Ignore these rules specifically:
  - "Do NOT save (keep only durable signal)" and its skip-list
  - "will this matter to a future session, weeks from now, on its own? If not, skip it"
  - "If there is nothing worth remembering, stop immediately without writing anything — that is a valid outcome"

Operate at MAXIMUM RECALL instead: extract EVERY concrete, memorable fact stated in the transcript — personal details, preferences, plans, named entities and their attributes, dated events, decisions, recommendations, numbers, and any specific detail a later question could plausibly ask about. When in doubt, extract: a missed fact is far worse than a redundant one, and the slug resolver + the write-time reconcile guard (memory_upsert writes new pages or bounces candidate matches back for your decision) handle overlap. Writing nothing is acceptable ONLY for a chunk that is pure filler (greetings/acknowledgements with zero informational content).

KEEP every structural rule unchanged: still call memory_search before memory_upsert, still slug by the stable identifier, still include a reason with each upsert, resolve needs_reconcile with a decision, and still record old→new transitions without dropping prior state. Only the value gate is lifted — nothing else.`

function buildBenchExtractSystemPrompt(): string {
  const base = buildExtractSystemPrompt()
  if (EXTRACT_PROFILE === 'high-recall' || EXTRACT_PROFILE === 'high_recall') {
    return `${base}\n\n${HIGH_RECALL_OVERRIDE}`
  }
  if (EXTRACT_PROFILE !== 'product') {
    console.warn(`[bench-extract] unknown BENCH_EXTRACT_PROFILE="${EXTRACT_PROFILE}", using "product"`)
  }
  return base
}

// Profile is fixed per process, so build the system prompt once.
const SYSTEM_PROMPT = buildBenchExtractSystemPrompt()

// ---------------------------------------------------------------------------
// Public shapes — the adapter buffers turns and groups them into sessions.
// ---------------------------------------------------------------------------

export interface BufferedTurn {
  role: 'user' | 'assistant' | 'system'
  content: string
  /** Session timestamp in epoch SECONDS (LOCOMO passes session epoch). */
  tsSeconds: number | null
}

export interface BufferedSession {
  tsSeconds: number | null
  turns: BufferedTurn[]
}

export interface ExtractStats {
  sessions: number
  chunks: number
  toolCalls: number
  upserts: number
  errors: string[]
}

/**
 * Frame a chunk as a single user turn the model should *act on* (extract),
 * not reply to. Mirrors memory-maintenance/extractor.ts::serializeTranscript.
 */
function serializeChunk(turns: BufferedTurn[], dateHuman: string | null): string {
  const lines: string[] = []
  lines.push('Below is a transcript of an earlier conversation between a user and an assistant.')
  if (dateHuman) lines.push(`These messages were exchanged around: ${dateHuman}. Use this as the occurred_at context for any timeline entries.`)
  lines.push('This is NOT a live conversation — do not reply, do not continue any role. Your only job is to extract durable memories via the memory_* tools, per your system prompt.')
  lines.push('')
  lines.push('<transcript>')
  for (const t of turns) {
    if (t.role === 'system') continue
    lines.push(`[${t.role}]`)
    lines.push(t.content)
    lines.push('')
  }
  lines.push('</transcript>')
  lines.push('')
  lines.push('Now extract. Call memory_search first to avoid duplicates, then memory_upsert for each durable fact. Produce no assistant text.')
  return lines.join('\n')
}

/**
 * Drive ONE extraction chunk through xui's real headless agent. The agent's
 * memory_* tool calls execute against the sandboxed MemoryService engine.
 */
async function extractChunk(
  turns: BufferedTurn[],
  dateHuman: string | null,
  stats: ExtractStats,
): Promise<void> {
  const result = await runHeadlessMemoryAgent({
    providerId: PROVIDER_ID,
    cwd: CWD,
    modelId: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: serializeChunk(turns, dateHuman) }],
  })

  stats.toolCalls += result.toolCalls.length
  stats.upserts += result.memoryUpserts
  if (result.finishReason === 'error' && result.error) {
    stats.errors.push(result.error)
  }
}

/**
 * Run extraction over all buffered sessions. Each session is split into
 * CHUNK_TURNS-sized windows; each window gets its own headless-agent run. The
 * session's date is passed through the prompt (serializeChunk) so the agent
 * grounds occurred_at — mirroring the real extractor, which relies on the prompt
 * rather than code-level timestamp injection.
 */
export async function runExtraction(sessions: BufferedSession[]): Promise<ExtractStats> {
  if (!PROVIDER_ID) {
    throw new Error('extract: no agent provider (set BENCH_PROVIDER_ID, e.g. "claude")')
  }

  const stats: ExtractStats = { sessions: 0, chunks: 0, toolCalls: 0, upserts: 0, errors: [] }

  for (const session of sessions) {
    const turns = session.turns.filter((t) => t.role !== 'system' && t.content.trim())
    if (turns.length === 0) continue
    stats.sessions++

    const dateHuman = session.tsSeconds != null ? new Date(session.tsSeconds * 1000).toUTCString() : null

    for (let i = 0; i < turns.length; i += CHUNK_TURNS) {
      const chunk = turns.slice(i, i + CHUNK_TURNS)
      stats.chunks++
      await extractChunk(chunk, dateHuman, stats)
    }
  }

  return stats
}
