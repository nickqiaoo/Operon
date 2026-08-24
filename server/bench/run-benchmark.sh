#!/usr/bin/env bash
#
# Orchestrate a memory-benchmarks run against xui's memory, one conversation at
# a time, each in a throwaway sandbox. xui has no per-user scoping, so isolation
# (and zero pollution of ~/.operon) comes from a fresh OPERON_DATA_DIR +
# OPERON_VECTOR_DIR per conversation and a process restart between them.
#
# LOCOMO / BEAM (scope per conversation, runner supports --conversations):
#   per conversation i:
#     1. fresh sandbox dir
#     2. launch the adapter (tsx bench/adapter.ts) on a per-conv port
#     3. wait for /health, then /warmup (downloads local models on first run)
#     4. python -m benchmarks.<bench>.run --conversations i --predict-only
#     5. kill adapter, drop sandbox
#   then once: --evaluate-only --conversations <list>  (answer+judge+aggregate)
#
# LongMemEval (scopes per QUESTION, 500 user_ids, NO --conversations flag):
#   ONE long-lived adapter over a single sandbox. The adapter resets its store
#   on each user_id (question) boundary, so questions stay isolated despite
#   xui's global store. The runner is forced sequential (--max-workers 1) so
#   user_ids never interleave. Then once: --evaluate-only (no adapter).
#
# Required env:
#   OPENAI_API_KEY        answerer LLM (--provider openai)
#   DEEPSEEK_API_KEY      judge LLM (default JUDGE_PROVIDER=deepseek; not needed
#                         if you override JUDGE_PROVIDER=openai)
#   BENCH_DIR             path to the cloned memory-benchmarks repo
#   BENCH_PROVIDER_ID     agent runtime that drives extraction (claude | codex |
#                         gemini | kimi | opencode | cursor | copilot | custom);
#                         its CLI must be available + authed here
# Useful env:
#   BENCH=locomo|longmemeval|beam   (default locomo)
#   CONVS="0 1 2 ... 9"             conversation indices (locomo/beam; default 0..9)
#   PER_TYPE=N                       longmemeval: sample N questions/type instead
#                                    of all 500 (handy for smoke tests)
#   PROJECT                          run name (default xui-<bench>)
#   ANSWERER_MODEL                   default gpt-4o (uses --provider openai)
#   JUDGE_MODEL / JUDGE_PROVIDER     default deepseek-v4-flash / deepseek. The
#                                    DeepSeek judge needs DEEPSEEK_API_KEY (own
#                                    key/base, independent of the answerer). Set
#                                    JUDGE_PROVIDER=openai JUDGE_MODEL=gpt-4o to
#                                    fall back to the OpenAI-keyed judge.
#   BENCH_EXTRACT_MODEL              model for the agent (default: agent's own)
#   BENCH_EXTRACT_PROFILE            product (default) | high-recall
#                                    product = real value-gated extractor;
#                                    high-recall = gate lifted, mem0-comparable
#                                    coverage (architecture number). Inherited by
#                                    the adapter process automatically.
#   KEEP_SANDBOX=1                   keep per-conv sandboxes for debugging
#   BASE_PORT                        default 8900
#
# NOTE: extraction now runs on the agent's own model. To compare against mem0,
# run mem0's extraction at the SAME model (not its published gpt-4o-mini number).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"          # server/bench
SERVER_DIR="$(cd "$HERE/.." && pwd)"                          # server
BENCH="${BENCH:-locomo}"
PROJECT="${PROJECT:-xui-$BENCH}"
ANSWERER_MODEL="${ANSWERER_MODEL:-gpt-4o}"
# Extraction coverage profile. Default is high-recall (gate lifted, mem0-comparable
# architecture number); set BENCH_EXTRACT_PROFILE=product for the value-gated
# product number. Exported so the adapter subprocess (extract.ts) inherits it.
export BENCH_EXTRACT_PROFILE="${BENCH_EXTRACT_PROFILE:-high-recall}"
# Judge defaults to DeepSeek: gpt-4o/stepfun judges were too strict and silently
# defaulted empty JSON-mode output to WRONG, crushing real scores by 10-45pts (see
# README "Judge"). deepseek-v4-flash is OpenAI-compatible and runs on its own
# key/base (DEEPSEEK_API_KEY) so it's independent of the answerer's OPENAI_* config.
JUDGE_PROVIDER="${JUDGE_PROVIDER:-deepseek}"
JUDGE_MODEL="${JUDGE_MODEL:-deepseek-v4-flash}"
BASE_PORT="${BASE_PORT:-8900}"
SANDBOX_ROOT="${SANDBOX_ROOT:-${TMPDIR:-/tmp}/xui-bench-$$}"

: "${OPENAI_API_KEY:?set OPENAI_API_KEY}"
: "${BENCH_DIR:?set BENCH_DIR to the cloned memory-benchmarks repo}"
: "${BENCH_PROVIDER_ID:?set BENCH_PROVIDER_ID to the extraction agent (e.g. claude)}"
[ "$JUDGE_PROVIDER" = "deepseek" ] && : "${DEEPSEEK_API_KEY:?set DEEPSEEK_API_KEY for the DeepSeek judge (or set JUDGE_PROVIDER=openai)}"
[ -d "$BENCH_DIR/benchmarks/$BENCH" ] || { echo "no benchmarks/$BENCH in $BENCH_DIR"; exit 1; }

# xui's native modules (better-sqlite3, sqlite-vec, node-llama-cpp) are built for
# Electron's ABI, not system node — so we run the adapter under Electron-as-node.
# This touches nothing in node_modules.
ELECTRON_BIN="${ELECTRON_BIN:-$(cd "$SERVER_DIR/.." && node -e "console.log(require('electron'))")}"
[ -x "$ELECTRON_BIN" ] || { echo "electron binary not found ($ELECTRON_BIN) — run 'pnpm install' in xui"; exit 1; }
run_adapter() { ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" --import tsx "$HERE/adapter.ts"; }

# Benchmark runner Python — needs the memory-benchmarks deps (openai, aiolimiter,
# datasets…), which live in the repo's venv. Prefer that venv so callers don't
# have to activate it; fall back to python/python3 on PATH.
PYTHON="${PYTHON:-}"
if [ -z "$PYTHON" ]; then
  if   [ -x "$BENCH_DIR/.venv/bin/python" ]; then PYTHON="$BENCH_DIR/.venv/bin/python"
  elif command -v python  >/dev/null 2>&1;   then PYTHON=python
  else                                            PYTHON=python3
  fi
fi

if [ -n "${CONVS:-}" ]; then read -r -a CONV_LIST <<< "$CONVS"; else CONV_LIST=(0 1 2 3 4 5 6 7 8 9); fi

echo ">> bench=$BENCH project=$PROJECT convs=${CONV_LIST[*]} agent=$BENCH_PROVIDER_ID model=${BENCH_EXTRACT_MODEL:-agent-default} profile=$BENCH_EXTRACT_PROFILE"
echo ">> sandbox root: $SANDBOX_ROOT (kept=${KEEP_SANDBOX:-0})"

ADAPTER_PID=""
cleanup() { [ -n "$ADAPTER_PID" ] && kill "$ADAPTER_PID" 2>/dev/null || true; }
trap cleanup EXIT

# Launch the adapter on $1=port with sandbox $2; block until /health, then
# /warmup (first run downloads ~1.2GB of local Qwen3 models — allow up to 10m).
launch_adapter() {
  local port="$1" sbx="$2"
  OPERON_DATA_DIR="$sbx/data" OPERON_VECTOR_DIR="$sbx/vector" BENCH_ADAPTER_PORT="$port" \
    run_adapter >"$sbx/adapter.log" 2>&1 &
  ADAPTER_PID=$!
  local ok=0
  for _ in $(seq 1 60); do
    curl -fsS "http://localhost:$port/health" >/dev/null 2>&1 && { ok=1; break; }
    sleep 1
    kill -0 "$ADAPTER_PID" 2>/dev/null || { echo "adapter died; see $sbx/adapter.log"; tail -20 "$sbx/adapter.log"; exit 1; }
  done
  [ "$ok" = 1 ] || { echo "adapter health timeout; see $sbx/adapter.log"; tail -20 "$sbx/adapter.log"; exit 1; }
  curl -fsS -m 600 -X POST "http://localhost:$port/warmup" >/dev/null
}
stop_adapter() {
  [ -n "$ADAPTER_PID" ] && { kill "$ADAPTER_PID" 2>/dev/null || true; wait "$ADAPTER_PID" 2>/dev/null || true; }
  ADAPTER_PID=""
}

if [ "$BENCH" = "longmemeval" ]; then
  # Per-question isolation via in-adapter store reset (xui has no user scoping
  # and longmemeval has no --conversations flag). One adapter, one sandbox,
  # sequential runner so user_ids never interleave.
  SCOPE_ARGS=(--all-questions)
  [ -n "${PER_TYPE:-}" ] && SCOPE_ARGS=(--per-type "$PER_TYPE")
  SBX="$SANDBOX_ROOT/all"; rm -rf "$SBX"; mkdir -p "$SBX/data" "$SBX/vector"
  echo "== longmemeval: single adapter, per-question store reset (scope: ${SCOPE_ARGS[*]}) port=$BASE_PORT"
  launch_adapter "$BASE_PORT" "$SBX"
  ( cd "$BENCH_DIR" && "$PYTHON" -m benchmarks.longmemeval.run \
      --project-name "$PROJECT" \
      --backend oss --mem0-host "http://localhost:$BASE_PORT" \
      "${SCOPE_ARGS[@]}" --max-workers 1 \
      --predict-only )
  stop_adapter
  [ "${KEEP_SANDBOX:-0}" = "1" ] || rm -rf "$SBX"

  echo ">> all questions ingested+searched. Judging + aggregating..."
  ( cd "$BENCH_DIR" && "$PYTHON" -m benchmarks.longmemeval.run \
      --project-name "$PROJECT" \
      "${SCOPE_ARGS[@]}" \
      --evaluate-only \
      --answerer-model "$ANSWERER_MODEL" --provider openai \
      --judge-model "$JUDGE_MODEL" --judge-provider "$JUDGE_PROVIDER" )
else
  # LOCOMO / BEAM: runner supports --conversations and scopes per conversation,
  # so isolate with a fresh sandbox + process restart per conversation.
  for i in "${CONV_LIST[@]}"; do
    PORT=$((BASE_PORT + i))
    SBX="$SANDBOX_ROOT/conv_$i"
    rm -rf "$SBX"; mkdir -p "$SBX/data" "$SBX/vector"
    echo "== conv $i: sandbox=$SBX port=$PORT"
    launch_adapter "$PORT" "$SBX"
    ( cd "$BENCH_DIR" && "$PYTHON" -m "benchmarks.$BENCH.run" \
        --project-name "$PROJECT" \
        --backend oss --mem0-host "http://localhost:$PORT" \
        --conversations "$i" \
        --predict-only )
    stop_adapter
    [ "${KEEP_SANDBOX:-0}" = "1" ] || rm -rf "$SBX"
  done

  echo ">> all conversations ingested+searched. Judging + aggregating..."
  ( cd "$BENCH_DIR" && "$PYTHON" -m "benchmarks.$BENCH.run" \
      --project-name "$PROJECT" \
      --conversations "$(IFS=,; echo "${CONV_LIST[*]}")" \
      --evaluate-only \
      --answerer-model "$ANSWERER_MODEL" --provider openai \
      --judge-model "$JUDGE_MODEL" --judge-provider "$JUDGE_PROVIDER" )
fi

[ "${KEEP_SANDBOX:-0}" = "1" ] || rm -rf "$SANDBOX_ROOT"
echo ">> done. Results in $BENCH_DIR/results/$BENCH/"
