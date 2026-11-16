#!/bin/bash
# Local release build: both macOS architectures, one after the other, in this
# working tree. CI builds them in parallel on two runners instead
# (.github/workflows/release-mac.yml) and merges latest-mac.yml in the publish job.
set -e

echo "=== TypeScript check ==="
tsc

restore_dev_binaries() {
  local build_status=$?
  trap - EXIT INT TERM
  bash scripts/restore-dev-native.sh
  local restore_status=$?
  if [ "$build_status" -ne 0 ]; then
    exit "$build_status"
  fi
  exit "$restore_status"
}
trap restore_dev_binaries EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Each arch build swaps the native binaries; restore them once at the end.
export OPERON_SKIP_DEV_RESTORE=1
bash scripts/build-mac-arch.sh arm64
bash scripts/build-mac-arch.sh x64

echo "=== Merging latest-mac.yml for both architectures ==="
node scripts/merge-latest-mac.mjs

echo "=== Done! Both versions are in release/ ==="
