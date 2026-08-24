#!/bin/bash
set -e

# Load .env variables for notarization (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

echo "=== TypeScript check ==="
tsc

echo "=== Cleaning previous build artifacts ==="
npm run clean:build

echo "=== Building ARM version (with Memory) ==="
TARGET_ARCH=arm64 npm run rebuild:native
# clean:build wiped dist-operon-runtime; rebuild the runtime JS bundles + the native
# Computer Use artifacts (Swift operon-computer-use binary + .node addons) that
# electron-builder packages as the `operon-runtime` extraResource. Arch-specific, so it
# must run per arch, after clean:build. Skipping this ships an app with no Computer Use engine.
TARGET_ARCH=arm64 npm run build:operon-runtime
TARGET_ARCH=arm64 npm run build:computer-use-native
vite build
electron-builder --mac

# Save ARM latest-mac.yml before Intel build overwrites it
cp release/latest-mac.yml release/latest-mac-arm64.yml

echo "=== Cleaning previous build artifacts ==="
npm run clean:build

echo "=== Building Intel version ==="
TARGET_ARCH=x64 npm run rebuild:native
# Same as the ARM block: rebuild the runtime + native Computer Use artifacts, this time
# cross-compiled for x86_64 (build:computer-use-native reads TARGET_ARCH).
TARGET_ARCH=x64 npm run build:operon-runtime
TARGET_ARCH=x64 npm run build:computer-use-native
vite build
electron-builder --mac --config electron-builder-intel.yml

# Merge both architectures into a single latest-mac.yml
echo "=== Merging latest-mac.yml for both architectures ==="
node scripts/merge-latest-mac.mjs

echo "=== Done! Both versions are in release/ ==="
