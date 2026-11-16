#!/bin/bash
# Put the host-architecture native binaries back into the working tree after a
# release build swapped them for another architecture's.
dev_arch="$(node -p 'process.arch')"
status=0

echo "=== Restoring native binaries for local development ($dev_arch) ==="
for task in rebuild:native build:native-addons fetch:cua-driver; do
  if ! TARGET_ARCH="$dev_arch" npm_config_arch="$dev_arch" SKIP_ELECTRON_REBUILD=0 npm run "$task"; then
    echo "Error: failed to restore $task for $dev_arch." >&2
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "=== Local development binaries restored ($dev_arch) ==="
fi
exit "$status"
