/**
 * xui Memory ↔ memory-benchmarks adapter (Mem0 OSS contract).
 * ============================================================
 *
 * Lets the mem0ai/memory-benchmarks suite drive xui's REAL memory stack
 * (engine + slug resolver + vector store + local Qwen3 embed/rerank + hybrid search)
 * by exposing the same minimal HTTP surface the benchmark's Mem0 OSS client
 * speaks (`POST /memories`, `POST /search`, `GET /health`).
 *
 * ZERO-POLLUTION DESIGN
 *   - SQLite  -> OPERON_DATA_DIR/operon.db   (env seam already in xui)
 *   - vectors -> OPERON_VECTOR_DIR           (1-line seam added to sqlite-vec-store)
 *   Both point at a throwaway sandbox dir. The only shared, READ-ONLY artifact
 *   is the local model cache (~/.operon/models), which is not benchmark data.
 *   One adapter process == one sandbox == one conversation (xui has no per-user
 *   scoping), so the runner restarts this process with a fresh sandbox per
 *   conversation. Your real ~/.operon data is never touched.
 *
 * INGEST -> EXTRACT (lazy)
 *   `/memories` only buffers turns. xui's real extraction is a daily batch job,
 *   so we replicate that batch shape: on the first `/search` we run extraction
 *   over the whole buffered transcript (see extract.ts), then serve the query.
 *   LOCOMO/LongMemEval/BEAM all fully ingest a conversation before searching it,
 *   so the flush boundary is safe.
 *
 * Run:  tsx server/bench/adapter.ts   (env: OPERON_DATA_DIR, OPERON_VECTOR_DIR,
 *                                       BENCH_ADAPTER_PORT, OPENAI_API_KEY, ...)
 */

import './enable-memory.js' // MUST be first — defines __ENABLE_MEMORY__ before xui imports

import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { SqliteStorage } from '../src/storage/sqlite.js'
import { initProviderConfigService, setProviderConfig } from '../src/services/provider-config.js'
import { initEmbeddingConfig, updateEmbeddingConfig } from '../src/services/vector/embeddings.js'
import { SqliteVecStore } from '../src/services/vector/sqlite-vec-store.js'
import { MemoryService, memorySearch } from '../src/services/memory/index.js'
import { registerOperonRuntimeTools } from '../src/services/operon-runtime/index.js'
import { buildOperonMemoryTools } from './memory-tools.js'
import { initAiService } from '../src/services/ai.js'
import type { MemoryPageResult } from '../src/services/memory/types.js'
import { runExtraction, EXTRACT_PROFILE, CHUNK_TURNS, type BufferedTurn, type BufferedSession } from './extract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_SRC = path.join(__dirname, '..', 'src')

const dataDir = process.env.OPERON_DATA_DIR || path.join(os.tmpdir(), 'xui-bench', 'data')
const dbPath = path.join(dataDir, 'operon.db')
const migrationsDir = path.join(SERVER_SRC, 'storage', 'migrations')
const PORT = Number(process.env.BENCH_ADAPTER_PORT || process.env.OPERON_PORT || 8899)

// --- Bootstrap the sandboxed memory stack ----------------------------------
const storage = new SqliteStorage(dbPath, { migrationsDir })
const db = storage.getDatabase()
initEmbeddingConfig(storage)
updateEmbeddingConfig({ enabled: true }) // turn on local Qwen3 embeddings -> vector store gets populated
SqliteVecStore.init() // reads OPERON_VECTOR_DIR

// Bootstrap xui's runtime so extraction runs through the REAL agent
// (runHeadlessMemoryAgent). initAiService wires chat storage / session manager;
// MemoryService.init points the shared memory singleton at the sandboxed db.
// The agent's memory_* tools dispatch to MemoryService.getInstance().getEngine(),
// so this single init is what keeps the agent's writes inside the sandbox — no
// MCP-layer change needed.
initAiService(storage)
MemoryService.init(db)
const engine = MemoryService.getInstance().getEngine()

// Give the in-process `custom` (operon) extraction agent the memory tools. CLI
// providers get these via MCP injection; the operon harness has no MCP wiring, so
// we register equivalent in-process tools that dispatch to the same engine.
// Without this, custom-provider extraction has no memory_* tools and writes
// nothing. No-op for CLI providers (claude/codex/…) which ignore this registry.
registerOperonRuntimeTools(buildOperonMemoryTools(engine))

// Provider-config store. The real app wires this in app.ts, but the bench
// bootstrap doesn't — so the `custom` (operon-agents) extraction provider would
// resolve its model to an EMPTY config (no baseUrl/apiKey) and fail. Seed one
// OpenAI-compatible provider from env so extraction can run through an arbitrary
// endpoint (e.g. stepfun): set BENCH_PROVIDER_ID=custom,
// BENCH_EXTRACT_MODEL=<providerId>/<model>, plus the BENCH_CUSTOM_* vars below.
// The seeded providerId must match BENCH_EXTRACT_MODEL's prefix (resolveModel
// keys the config by that prefix). Default the providerId to that prefix so you
// usually only need BENCH_CUSTOM_BASE_URL + BENCH_CUSTOM_API_KEY.
initProviderConfigService(storage)
const customBaseUrl = process.env.BENCH_CUSTOM_BASE_URL
const customApiKey = process.env.BENCH_CUSTOM_API_KEY
if (customBaseUrl || customApiKey) {
  const modelPrefix = (process.env.BENCH_EXTRACT_MODEL ?? '').split('/')[0]
  const customProviderId = process.env.BENCH_CUSTOM_PROVIDER_ID || modelPrefix
  if (!customProviderId) {
    console.warn('[bench-adapter] BENCH_CUSTOM_* set but no provider id — set BENCH_CUSTOM_PROVIDER_ID or a slashed BENCH_EXTRACT_MODEL')
  } else {
    setProviderConfig(customProviderId, { enabled: true, apiKey: customApiKey, baseUrl: customBaseUrl })
    console.log(
      `[bench-adapter] seeded custom provider "${customProviderId}" ` +
        `baseUrl=${customBaseUrl ?? '(provider default)'} apiKey=${customApiKey ? 'set' : 'MISSING'}`,
    )
  }
}

// --- Buffered, chunked extraction --------------------------------------------
// The benchmark streams one /memories per user+assistant pair, but running our
// agentic extractor (memory_search→memory_upsert loop) per pair would be hundreds
// of loops per question (~hours) and give it only one isolated pair of context. So
// we BUFFER and extract in chunks: turns accumulate within a session (identified by
// the runner's `session_id`, falling back to `timestamp` when absent); we fire one
// extraction once the buffer reaches CHUNK_TURNS, and flush whatever remains at a
// session boundary (so a chunk never spans two sessions), at a user_id switch, or
// on the first /search (for the very last session). The extractor — whose prompt
// reads a transcript — thus sees up to a CHUNK_TURNS slice of ONE session. The
// benchmark protocol is unchanged; only WHEN/HOW-MUCH we extract changes.
let seenUser: string | null = null
// Serializes chunk extractions so they never race the engine. runExtraction never
// throws (errors go into stats), so the chain survives a failed chunk.
let extractChain: Promise<void> = Promise.resolve()
// Open (not-yet-extracted) buffer. `openKey` is the session boundary key
// (session_id if the runner sent one, else the timestamp); `openTs` is the session
// timestamp used to ground occurred_at during extraction.
let openKey: string | number | null = null
let openTs: number | null = null
let openTurns: BufferedTurn[] = []
let extractCount = 0
let cumUpserts = 0

/** Wipe the sandbox memory store (SQLite content tables + vectors) and the open
 *  session buffer. xui has no per-user scoping, so when the benchmark advances to
 *  a new user_id we reset in place. Callers must drain in-flight extractions
 *  (await extractChain) before calling this. */
function resetStore(): void {
  // FTS5 external-content mirrors are kept in sync by the AFTER DELETE triggers.
  db.exec('DELETE FROM memory_timeline; DELETE FROM memory_page;')
  SqliteVecStore.getInstance()?.clear()
  extractChain = Promise.resolve()
  openKey = null
  openTs = null
  openTurns = []
  extractCount = 0
  cumUpserts = 0
}

/** Queue extraction of one buffered session onto the serialized chain. The
 *  session timestamp grounds occurred_at (mirrors the real extractor, which relies
 *  on the prompt rather than code-level timestamp injection). Returns the chain so
 *  callers can await full drain. */
function enqueueSession(turns: BufferedTurn[], tsSeconds: number | null): Promise<void> {
  if (turns.length === 0) return extractChain
  const session: BufferedSession = { tsSeconds, turns }
  extractChain = extractChain.then(async () => {
    const stats = await runExtraction([session])
    extractCount += 1
    cumUpserts += stats.upserts
    console.log(
      `[bench-adapter] extract #${extractCount} (ts=${tsSeconds}) turns=${turns.length} ` +
        `chunks=${stats.chunks} toolCalls=${stats.toolCalls} upserts=${stats.upserts} ` +
        `errors=${stats.errors.length} (cum upserts=${cumUpserts})`,
    )
  })
  return extractChain
}

/** Flatten xui pages into the flat scored-memory list the benchmark expects.
 *  xui returns pages in rerank order, so we attach a synthetic descending score
 *  to preserve that ranking through the benchmark's top-k cutoffs. */
function flatten(pages: MemoryPageResult[]): Array<Record<string, unknown>> {
  const n = pages.length
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10) // YYYY-MM-DD
  return pages.map((p, i) => {
    // Surface occurred_at dates in the memory TEXT. The benchmark answers ONLY from
    // this string, so without dates here a "when did X happen" question is
    // unanswerable even though the event (with its date) is stored — the date lives
    // in timeline.occurred_at, not in the truth prose.
    // Only surface dates we actually know (occurred_at != null). A NULL occurred_at
    // means the event time is unknown — never show the write time as the event date.
    const dates = [
      ...new Set(p.timeline.filter((e) => e.occurred_at != null).map((e) => day(e.occurred_at as number))),
    ].sort()
    const header = `[${p.type}/${p.slug}]${dates.length ? ` (${dates.join(', ')})` : ''} ${p.truth}`
    const matched = p.timeline
      .filter((e) => e.matched)
      .map((e) => `- ${e.occurred_at != null ? `${day(e.occurred_at)}: ` : ''}${e.entry}`)
    const lines = [header]
    if (matched.length) lines.push('History:', ...matched)
    const iso = new Date(p.updated_at).toISOString()
    return {
      id: `${p.type}/${p.slug}`,
      memory: lines.join('\n'),
      score: n > 1 ? 1 - i / n : 1,
      created_at: iso,
      updated_at: iso,
    }
  })
}

// --- HTTP surface (Mem0 OSS contract) --------------------------------------
const app = new Hono()

app.get('/health', (c) => c.json({ status: 'ok', backend: 'xui', db: dbPath }))

// Pre-load the local Qwen3 embed/rerank models (first run downloads ~600MB to
// ~/.operon/models). Call this once after /health so the first real /search
// doesn't hit the benchmark's request timeout while the model downloads.
app.post('/warmup', async (c) => {
  try {
    await memorySearch(engine, 'warmup', { limit: 1 })
    return c.json({ status: 'warm' })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/memories', async (c) => {
  try {
    const body = await c.req.json<{
      messages: Array<{ role?: string; content?: string }>
      user_id?: string
      timestamp?: number
      session_id?: string
    }>()
    // New user_id => new conversation/question. xui has no per-user scoping, so
    // reset the sandbox store here to keep the previous conversation's memories
    // from leaking into this one. (No-op for the per-conversation-process model:
    // each LOCOMO/BEAM process only ever sees one user_id.)
    if (body.user_id && body.user_id !== seenUser) {
      if (seenUser !== null) {
        await extractChain.catch(() => {}) // drain in-flight extractions before reset
        console.log(`[bench-adapter] user_id ${seenUser} -> ${body.user_id}; resetting sandbox store`)
        resetStore()
      }
      seenUser = body.user_id
    }

    const ts = typeof body.timestamp === 'number' ? body.timestamp : null
    // Prefer the runner's real session id for the boundary; fall back to the
    // timestamp when it didn't send one. (mem0's /memories contract has no session
    // field, so historically we could only infer boundaries from the timestamp —
    // which happens to be unique per session here, but is a fragile proxy.)
    const key: string | number | null = body.session_id ?? ts
    // A new session closes the open one: flush its remaining turns before buffering
    // the new session, so a chunk never spans two sessions.
    if (openTurns.length > 0 && key !== openKey) {
      const prevTurns = openTurns
      const prevTs = openTs
      openTurns = []
      await enqueueSession(prevTurns, prevTs)
    }
    openKey = key
    openTs = ts
    for (const m of body.messages ?? []) {
      const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user'
      const content = (m.content ?? '').trim()
      if (content) openTurns.push({ role, content, tsSeconds: ts })
    }
    // Fire extraction as soon as the buffer reaches a chunk; keep the remainder for
    // the next pairs (or the session-boundary flush above). Await so chunks extract
    // in order and ingest is paced under the benchmark's 300s add timeout.
    while (openTurns.length >= CHUNK_TURNS) {
      const chunk = openTurns.slice(0, CHUNK_TURNS)
      openTurns = openTurns.slice(CHUNK_TURNS)
      await enqueueSession(chunk, openTs)
    }
    return c.json({ results: [] }) // benchmark only uses the add response for debug logging
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/search', async (c) => {
  try {
    const body = await c.req.json<{ query: string; user_id?: string; limit?: number }>()
    if (!body.query?.trim()) return c.json({ error: 'query is required' }, 400)
    // Final flush: the last session has no following timestamp to close it, so the
    // first search extracts it. Then drain the chain so the store is fully
    // populated before we search. Subsequent searches see an empty openTurns and
    // just await an already-resolved chain.
    if (openTurns.length > 0) {
      const lastTurns = openTurns
      const lastTs = openTs
      openTurns = []
      enqueueSession(lastTurns, lastTs)
    }
    await extractChain.catch(() => {})
    const limit = body.limit ?? 200
    const pages = await memorySearch(engine, body.query, { limit })
    return c.json({ results: flatten(pages) })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// Benchmark cleanup hooks. These fully wipe the sandbox store (not just the
// buffer), so a long-lived adapter can be reset between runs as well.
app.delete('/memories', async (c) => {
  await extractChain.catch(() => {}) // drain in-flight extractions first
  resetStore()
  return c.json({ message: 'store cleared' })
})
app.post('/reset', async (c) => {
  await extractChain.catch(() => {}) // drain in-flight extractions first
  resetStore()
  seenUser = null
  return c.json({ message: 'reset' })
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(
    `[bench-adapter] xui memory on :${info.port}\n` +
      `  db=${dbPath}\n  vec=${process.env.OPERON_VECTOR_DIR ?? '(default ~/.operon/vector — NOT sandboxed!)'}\n` +
      `  agent-provider=${process.env.BENCH_PROVIDER_ID || '(unset!)'} model=${process.env.BENCH_EXTRACT_MODEL || '(agent default)'} profile=${EXTRACT_PROFILE}`,
  )
  if (!process.env.OPERON_VECTOR_DIR) {
    console.warn('[bench-adapter] OPERON_VECTOR_DIR is unset — refusing to risk polluting ~/.operon/vector.')
    console.warn('[bench-adapter] Set OPERON_VECTOR_DIR (and OPERON_DATA_DIR) to a sandbox dir. Exiting.')
    process.exit(1)
  }
})
