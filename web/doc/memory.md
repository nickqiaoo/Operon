# Memory

## What is it

Memory gives the AI long-term context about you and your projects. Instead of repeating the same instructions every conversation, the AI can recall your preferences, coding patterns, project decisions, and past interactions across sessions.

## How it works

Each memory is a **page** keyed by `(type, slug)`. A page has:

- **`truth`** — the current best understanding of the topic. Replaced (not appended) on every write.
- **`timeline`** — an append-only log explaining *why* the truth changed each time. Every write must include one entry.

This two-layer model lets the AI keep one canonical answer per topic while preserving the history of how that answer evolved.

Operon exposes two MCP tools that AI agents call during a conversation to read and write memory:

- **`memory_search`** — hybrid retrieval across pages (truth + timeline). Accepts multiple `types` in a single call.
- **`memory_upsert`** — write through a reconcile flow. First submit `content` and `reason`; if a similar page exists, the tool returns candidates instead of writing.

### Slug resolver (reconcile)

`memory_upsert` does not blindly create a new page for every new `slug_hint`. Before writing, it checks deterministic identity matches (exact slug, normalized slug, learned alias) and semantic candidates under the same type. If a candidate exists, the call returns `status: "needs_reconcile"` with each candidate's `slug`, `truth`, and `revision`. The agent then re-calls `memory_upsert` with `decision.action = "merge"` and a full merged page `truth`, or `decision.action = "create"` if the incoming content is genuinely a new page. This prevents duplicate pages without letting a short new fact overwrite an existing page summary.

### Singleton types

`profile` and `preferences` are forced to slug `"user"` — there is exactly one of each. `slug_hint` is ignored for these two types.

### Storage

Memory lives in the main Operon SQLite database (`memory_pages`, `memory_timeline`, `memory_timeline_fts` tables) and a local sqlite-vec vector store. Nothing is sent to a remote service.

### Retrieval architecture

`memory_search` runs a **3-way hybrid retrieval** pipeline to find the most relevant pages:

1. **Page-truth keyword search** — SQLite FTS5 + BM25 over each page's `truth`.
2. **Timeline keyword search** — SQLite FTS5 + BM25 over `memory_timeline.entry`.
3. **Vector semantic search** — A local embedding model (Qwen3-Embedding-0.6B) converts truth chunks and timeline entries into 1024-dimensional vectors, and retrieval runs over both via cosine distance in a local sqlite-vec store.

The three ranked lists are merged with Reciprocal Rank Fusion (k=60): `score(d) = Σ 1/(k + rank_i(d))`. Fused results are then grouped by `(type, slug)` so each page surfaces once, ordered by its best fused score.

## Memory categories

- **Profile** *(singleton)* — Your role, expertise, and background. Helps the AI tailor its responses to your skill level.
- **Preferences** *(singleton)* — How you like things done: code style, communication style, tools you prefer.
- **Entities** — People, projects, services, and other named things the AI should remember.
- **Events** — Decisions, incidents, deadlines, and other time-sensitive context.
- **Cases** — Specific problems and their resolutions. Useful for recurring issues.
- **Patterns** — Recurring approaches, architectural decisions, and conventions in your codebase.

## Managing memories

### Browsing

1. Go to **Settings > Memory**.
2. Switch to the **Memory** sub-tab.
3. Each page is listed with its type, slug, and truth preview. Expand a row to see the full timeline of that page.
4. Use the search bar to run a semantic search across all memory.
5. Filter by category using the category buttons.

### Deleting

Deleting a page removes its truth, all timeline entries, and the associated vectors. The AI will no longer have access to that topic until a new page is created.

## Embedding configuration

Semantic memory search requires a local embedding model.

1. Go to **Settings > Memory > Embedding**.
2. Download the embedding model (Qwen3-Embedding-0.6B).
3. The system auto-detects your GPU for acceleration. CPU fallback is available.
4. Once downloaded, use the test button to verify the model works.

All embedding runs locally — no data leaves your machine for memory operations.
