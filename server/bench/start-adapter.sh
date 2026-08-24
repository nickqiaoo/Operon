#!/usr/bin/env bash
#
# Launch ONE xui memory adapter process under Electron-as-node (the ABI xui's
# native modules are built for). Use this for a single conversation / manual
# run; for a full multi-conversation benchmark with per-conversation isolation
# use run-benchmark.sh instead.
#
# Required env:
#   OPERON_DATA_DIR     sandbox dir for SQLite     (e.g. /tmp/xui-bench/data)
#   OPERON_VECTOR_DIR   sandbox dir for vectors    (e.g. /tmp/xui-bench/vector)
#   BENCH_PROVIDER_ID   extraction agent (claude | codex | gemini | kimi |
#                       opencode | cursor | copilot | custom); CLI must be authed
# Optional:
#   BENCH_ADAPTER_PORT     default 8899
#   BENCH_EXTRACT_MODEL    model for the agent (default: agent's own)
#   BENCH_EXTRACT_PROFILE  product (default) | high-recall
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
XUI_ROOT="$(cd "$HERE/../.." && pwd)"

: "${OPERON_DATA_DIR:?set OPERON_DATA_DIR to a sandbox dir (never your real ~/.operon)}"
: "${OPERON_VECTOR_DIR:?set OPERON_VECTOR_DIR to a sandbox dir (never ~/.operon/vector)}"
mkdir -p "$OPERON_DATA_DIR" "$OPERON_VECTOR_DIR"

ELECTRON_BIN="${ELECTRON_BIN:-$(cd "$XUI_ROOT" && node -e "console.log(require('electron'))")}"
[ -x "$ELECTRON_BIN" ] || { echo "electron binary not found ($ELECTRON_BIN) — run 'pnpm install' in xui"; exit 1; }

exec env ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" --import tsx "$HERE/adapter.ts"
