#!/bin/bash
set -e

# Load .env variables for notarization (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Node's fetch ignores the macOS system proxy, so downloads like fetch:cua-driver
# (GitHub release assets) go direct and get reset. Mirror the system HTTPS proxy
# into the env vars Node reads, unless the caller already set one.
if [ -z "$HTTPS_PROXY" ] && [ -z "$https_proxy" ]; then
  proxy_info="$(scutil --proxy 2>/dev/null || true)"
  if echo "$proxy_info" | grep -q 'HTTPSEnable : 1'; then
    proxy_host="$(echo "$proxy_info" | awk '/HTTPSProxy :/ {print $3}')"
    proxy_port="$(echo "$proxy_info" | awk '/HTTPSPort :/ {print $3}')"
    if [ -n "$proxy_host" ] && [ -n "$proxy_port" ]; then
      export HTTPS_PROXY="http://$proxy_host:$proxy_port" HTTP_PROXY="http://$proxy_host:$proxy_port"
      export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1}"
      echo "=== Using system proxy $HTTPS_PROXY ==="
    fi
  fi
fi
if [ -n "$HTTPS_PROXY$https_proxy" ]; then
  export NODE_USE_ENV_PROXY=1
fi

# Pin the SDK to the selected Xcode's own. Otherwise xcrun can hand native builds
# the newer Command Line Tools SDK, whose .tbd stubs an older ld can't read
# ("unknown architecture arm64e.x1-macos").
if [ -z "$SDKROOT" ]; then
  SDKROOT="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
  [ -n "$SDKROOT" ] && export SDKROOT && echo "=== Using SDK $SDKROOT ==="
fi

echo "=== TypeScript check ==="
tsc

echo "=== Cleaning previous build artifacts ==="
npm run clean:build

echo "=== Building ARM version (with Memory) ==="
TARGET_ARCH=arm64 npm run rebuild:native
# clean:build wiped dist-operon-runtime; rebuild the runtime JS bundles + the native
# addons that electron-builder packages as the `operon-runtime` extraResource.
# Arch-specific, so it must run per arch, after clean:build.
TARGET_ARCH=arm64 npm run build:operon-runtime
TARGET_ARCH=arm64 npm run build:native-addons
# cua-driver is the Computer Use engine: an upstream release binary, not built
# here. Upstream ships it universal; the fetch script thins it to TARGET_ARCH,
# which halves it, so this is per-arch like the addons above. Skipping this
# ships an app with no Computer Use engine.
TARGET_ARCH=arm64 npm run fetch:cua-driver
vite build
electron-builder --mac

# Save ARM latest-mac.yml before Intel build overwrites it
cp release/latest-mac.yml release/latest-mac-arm64.yml

echo "=== Cleaning previous build artifacts ==="
npm run clean:build

echo "=== Building Intel version ==="
TARGET_ARCH=x64 npm run rebuild:native
# Same as the ARM block: rebuild the runtime + native addons, this time
# cross-compiled for x86_64 (build:native-addons reads TARGET_ARCH).
TARGET_ARCH=x64 npm run build:operon-runtime
TARGET_ARCH=x64 npm run build:native-addons
TARGET_ARCH=x64 npm run fetch:cua-driver
vite build
electron-builder --mac --config electron-builder-intel.yml

# Merge both architectures into a single latest-mac.yml
echo "=== Merging latest-mac.yml for both architectures ==="
node scripts/merge-latest-mac.mjs

echo "=== Done! Both versions are in release/ ==="
