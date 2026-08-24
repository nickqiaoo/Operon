# xui Memory ↔ memory-benchmarks adapter

Runs the [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks)
suite (LOCOMO / LongMemEval / BEAM) against **xui's real memory stack** — the
same engine, slug resolver, vector store, local Qwen3 embed/rerank, and hybrid
search the product uses — so you get scores directly comparable to mem0's.

## How it maps onto the benchmark

The benchmark only speaks the Mem0 OSS HTTP contract (`POST /memories`,
`POST /search`, `GET /health`). This adapter implements that contract on top of
xui:

| Benchmark call | What the adapter does |
|----------------|-----------------------|
| `POST /memories` | Buffers the conversation turns (no write yet). |
| `POST /search` (first one) | **Extracts** the whole buffered transcript into xui memory, then searches. |
| `POST /search` (rest) | xui `memorySearch` (FTS + vector + RRF + Qwen3 rerank). |

**Extraction** runs through xui's **real agent runtime**: `extract.ts` drives
`runHeadlessMemoryAgent` (the same driver the product's daily extractor uses) with
xui's real extraction system prompt (`buildExtractSystemPrompt`) and the agent's
own memory_* tools (injected via the provider's normal session construction). Pick
the agent with `BENCH_PROVIDER_ID` (e.g. `claude`); its CLI must be available and
authed in this environment. Buffer-then-extract mirrors xui's real daily batch
extractor (it sees a whole transcript at once), which fits the benchmark's
"ingest a conversation fully, then search it" flow.

Because the agent's memory writes go through `MemoryService.getInstance().getEngine()`
and the adapter calls `MemoryService.init(sandboxedDb)`, all writes stay in the
sandbox — isolation needs no MCP-layer change.

> **Comparing to mem0:** extraction now runs on the agent's own model (e.g.
> Claude), not gpt-4o-mini. For a fair comparison, run mem0's extraction at the
> **same** model (mem0 server `LLM_MODEL` / `BENCH_EXTRACT_MODEL`) rather than
> citing mem0's published gpt-4o-mini numbers.

> **Dedup happens at write time, not in a separate pass.** Duplicate pages are
> reconciled inside `memory_upsert`: the engine probes for existing identities
> and near-duplicates, then either creates a new page or returns `needs_reconcile`
> to the extracting agent. The agent re-calls `memory_upsert` with
> `decision.action="merge"` and a full merged truth, or `decision.action="create"`
> for a genuinely new page. So the benchmark exercises the same write-time dedup
> the product uses — there is no longer a Layer 2 "consolidate" pass to add as a
> flush step (that layer was removed).

### Two numbers: product vs high-recall (`BENCH_EXTRACT_PROFILE`)

xui's extractor has a **value gate** — it deliberately skips transient/low-signal
content ("will this matter weeks from now, on its own? If not, skip it"). mem0's
extractor is the opposite ("when in doubt, extract; dedup downstream"). On
recall-stressed benchmarks that ask about arbitrary specific details, that gate
costs you questions, and it confounds the result: a miss could be a weak
architecture *or* just a gated-out fact. So there are two distinct numbers:

| `BENCH_EXTRACT_PROFILE` | What it measures | Compare to mem0? |
|-------------------------|------------------|------------------|
| `product` (default)     | xui's real, value-gated memory — the honest product number | apples-to-oranges (different coverage philosophy) |
| `high-recall`           | xui's **architecture** (page/slug/truth/timeline model, slug resolver, hybrid retrieval, reranker) with the value gate lifted so coverage matches mem0 | yes — fair, coverage-neutralized |

Both profiles run through the **same real agent, model, tools and engine** — the
**only** difference is the system prompt's value gate. `high-recall` is **not** a
port of mem0's extractor; it just appends an override that suspends the gate (keeps
slug-by-identity, search-before-upsert, reason, reconcile decisions, and old→new transitions).
The **delta** between the two numbers is exactly the recall cost of the value gate
on this benchmark — a useful product signal in itself.

> Caveat: these benchmarks reward hoarding, which is *not* the same objective as a
> good product memory. Use `high-recall` to judge architecture vs mem0; do **not**
> use these benchmarks to tune the product's value gate.

## Judge

The benchmark's final score is an LLM judge labelling each answer CORRECT/WRONG
against the gold answer (LOCOMO's binary-judge methodology, categories 1-4). The
judge is **the** confounder here: a strict or flaky judge marks correct
paraphrases WRONG and tanks the score even when retrieval + memory are fine.

We saw this directly. The earlier gpt-4o/stepfun judge silently defaulted empty
JSON-mode output to WRONG and over-rejected obvious paraphrases. Re-judging the
**same generated answers** (answerer held fixed) with `deepseek-v4-flash`:

| Run (conv0, top_200) | old judge | DeepSeek judge |
|----------------------|-----------|----------------|
| `predicted_xui-8sess`    | 47.8% (top_20) → 71.6% (top_200) | **92.5% / ~96%** |
| `predicted_xui-8sess-v2` | 85.1% | **95.5%** |

The flips were all real judge errors, e.g. `"Charlotte's Web."` vs
`Charlotte's Web`, `"Becoming Nicole" by Amy Ellis Nutt` vs `Becoming Nicole`.

So the judge now defaults to **DeepSeek** (`JUDGE_PROVIDER=deepseek`,
`JUDGE_MODEL=deepseek-v4-flash`), which runs on its own `DEEPSEEK_API_KEY` /
base URL — independent of the answerer's `OPENAI_*` config so swapping the judge
never disturbs answer generation. `deepseek-v4-flash` is a reasoning model:
under JSON mode it emits empty `content` only when the token budget is too small
for reasoning + output, so the judge call keeps the full 4096-token budget (and
the client's plain-text CORRECT/WRONG fallback still covers any empties).

To isolate the judge variable on existing predictions (re-judge stored answers
without re-running the answerer), use `rejudge_deepseek.py` in the benchmark repo:

```bash
DEEPSEEK_API_KEY=sk-... .venv/bin/python rejudge_deepseek.py predicted_<name>
```

Override the default to judge with OpenAI instead:
`JUDGE_PROVIDER=openai JUDGE_MODEL=gpt-4o`.

## Zero-pollution guarantees

- **SQLite** → `OPERON_DATA_DIR/operon.db`, **vectors** → `OPERON_VECTOR_DIR`. Both
  point at a throwaway sandbox dir. The adapter **refuses to start** if
  `OPERON_VECTOR_DIR` is unset (so it can't fall back to `~/.operon/vector`).
- xui has no per-user scoping, so isolation is **per `user_id` boundary**:
  - **LOCOMO / BEAM** (runner scopes per conversation, supports
    `--conversations`): `run-benchmark.sh` gives each conversation its own
    sandbox and restarts the process between them.
  - **LongMemEval** (scopes per *question* — 500 `user_id`s — and has **no**
    `--conversations` flag): one long-lived adapter over a single sandbox. The
    adapter **resets its store** (SQLite content tables + vectors) whenever the
    benchmark advances to a new `user_id`, so questions stay isolated. The
    runner is forced sequential (`--max-workers 1`) so `user_id`s never
    interleave. Per-question `--all-questions --max-workers 1` is slower than
    LOCOMO but correct; use `PER_TYPE=N` for a quick stratified sample.

  Your real `~/.operon` data is never touched either way.
- The only shared, **read-only** artifact is the local model cache
  (`~/.operon/models`, ~1.2 GB Qwen3 embed+rerank) — not benchmark data.

## Requirements

- xui deps installed (`pnpm install` at the xui root) — provides `tsx`, the
  native modules, and the Electron binary used as the runtime.
- An **agent** for extraction: set `BENCH_PROVIDER_ID` to one of `claude`, `codex`,
  `gemini`, `kimi`, `opencode`, `cursor`, `copilot`, `custom`. That agent's CLI
  must be installed and authed in this environment (it brings its own model/auth).
- An OpenAI-compatible API key (`OPENAI_API_KEY`) for the benchmark's
  **answerer** model.
- A `DEEPSEEK_API_KEY` for the **judge** (default `JUDGE_PROVIDER=deepseek`,
  model `deepseek-v4-flash`). See [Judge](#judge) for why the judge runs on a
  separate model. Set `JUDGE_PROVIDER=openai JUDGE_MODEL=gpt-4o` to instead judge
  with the OpenAI key.
- The local Qwen3 models auto-download to `~/.operon/models` on first
  `/warmup` (already present if you've used xui memory).
- The benchmark repo cloned somewhere (`BENCH_DIR`), with its Python deps:
  `pip install -r requirements.txt` (plus `pip install datasets` for BEAM).

### Why Electron-as-node?

xui's native modules (`better-sqlite3`, `sqlite-vec`, `node-llama-cpp`) are
compiled for Electron's ABI (NODE_MODULE_VERSION 143), not system node. The
scripts run the adapter via `ELECTRON_RUN_AS_NODE=1 <electron> --import tsx`,
which matches the ABI **without rebuilding or touching `node_modules`**.

## Run it

Full LOCOMO, isolated per conversation, then judge + aggregate:

```bash
export OPENAI_API_KEY=sk-...
export BENCH_DIR=/path/to/memory-benchmarks
# optional: export BENCH_EXTRACT_MODEL=gpt-4o-mini  ANSWERER_MODEL=gpt-4o  JUDGE_MODEL=gpt-4o
bash server/bench/run-benchmark.sh
# results land in $BENCH_DIR/results/locomo/
```

Quick smoke (one conversation):

```bash
CONVS="0" bash server/bench/run-benchmark.sh
```

Other benchmarks:

```bash
# LongMemEval — all 500 questions (single adapter, per-question store reset)
BENCH=longmemeval bash server/bench/run-benchmark.sh
# quick stratified smoke (N per question type):
BENCH=longmemeval PER_TYPE=2 bash server/bench/run-benchmark.sh

# BEAM — set CONVS for the conversation indices in the size bucket
BENCH=beam CONVS="0 1 2" bash server/bench/run-benchmark.sh
```

### Manual / single process

```bash
OPERON_DATA_DIR=/tmp/xb/data OPERON_VECTOR_DIR=/tmp/xb/vector \
OPENAI_API_KEY=sk-... bash server/bench/start-adapter.sh
# then point the benchmark at it:
cd $BENCH_DIR && python -m benchmarks.locomo.run \
  --project-name xui-manual --backend oss --mem0-host http://localhost:8899 --conversations 0
```

## Config (env)

| Var | Default | Purpose |
|-----|---------|---------|
| `OPERON_DATA_DIR` | `…/tmp/xui-bench/data` | sandbox SQLite dir (required for isolation) |
| `OPERON_VECTOR_DIR` | — (**required**) | sandbox vector dir; adapter exits if unset |
| `BENCH_ADAPTER_PORT` | `8899` | adapter HTTP port |
| `BENCH_PROVIDER_ID` | — (**required**) | agent runtime that drives extraction (`claude`, `codex`, `gemini`, `kimi`, `opencode`, `cursor`, `copilot`, `custom`) |
| `BENCH_EXTRACT_MODEL` | — (agent default) | model id for the agent; unset uses the agent's own default |
| `BENCH_EXTRACT_CWD` | `process.cwd()` | working dir for the agent session |
| `BENCH_EXTRACT_PROFILE` | `product` | `product` (value-gated, real) or `high-recall` (gate lifted, mem0-comparable). See [Two numbers](#two-numbers-product-vs-high-recall-bench_extract_profile) |
| `BENCH_EXTRACT_CHUNK_TURNS` | `30` | turns per extraction chunk |

## Files

- `adapter.ts` — HTTP server (Mem0 OSS contract) over the sandboxed engine.
- `extract.ts` — plain-LLM tool-loop using xui's real extract prompt + tools.
- `enable-memory.ts` — defines `__ENABLE_MEMORY__` before xui imports load.
- `run-benchmark.sh` — per-conversation isolated orchestrator.
- `start-adapter.sh` — single adapter process launcher.

## Changes outside this folder

`src/services/vector/sqlite-vec-store.ts` has two small, backward-compatible additions:

1. A sandboxable vector dir (mirrors the existing `OPERON_DATA_DIR` seam) — when
   `OPERON_VECTOR_DIR` is unset, behaviour is unchanged:

   ```ts
   const VECTOR_DIR = process.env.OPERON_VECTOR_DIR || path.join(os.homedir(), '.operon', 'vector')
   ```

2. A `SqliteVecStore.clear()` method that wipes all vectors in place (closes
   collections + deletes their on-disk data) while keeping the singleton alive.
   The adapter calls it on each `user_id` boundary to reset a sandbox without a
   process restart. Nothing in the product calls `clear()`, so behaviour there
   is unchanged.
