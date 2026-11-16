#!/bin/bash
# Build, sign and notarize the macOS app for ONE architecture.
#
#   bash scripts/build-mac-arch.sh arm64|x64
#
# CI runs one of these per runner, both architectures side by side
# (.github/workflows/release-mac.yml). Locally, scripts/build-all-mac.sh runs it
# once per architecture.
#
# Output in release/:
#   arm64 -> Operon-<v>-arm64.dmg / -arm64-mac.zip (+ blockmaps), latest-mac-arm64.yml
#   x64   -> Operon-<v>.dmg / -mac.zip (+ blockmaps), latest-mac.yml
# scripts/merge-latest-mac.mjs then folds latest-mac-arm64.yml into latest-mac.yml.
set -e

arch="$1"
case "$arch" in
  arm64) builder_config=electron-builder.yml ;;
  x64) builder_config=electron-builder-intel.yml ;;
  *)
    echo "Usage: $0 arm64|x64" >&2
    exit 2
    ;;
esac

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

# The build overwrites the working tree's native binaries with $arch ones.
# Restore the host versions on every exit so an Intel build cannot leave DEV
# using x86_64 addons on an ARM Mac (or vice versa). Packaged files in release/
# stay untouched. CI runners are thrown away, and build-all-mac.sh restores once
# after both architectures, so both skip it.
if [ -z "$CI" ] && [ -z "$OPERON_SKIP_DEV_RESTORE" ]; then
  restore_dev_binaries() {
    local build_status=$?
    trap - EXIT INT TERM
    bash scripts/restore-dev-native.sh
    local restore_status=$?
    # Preserve the original build failure; fail successful builds if restoration
    # failed, rather than silently leaving a broken development environment.
    if [ "$build_status" -ne 0 ]; then
      exit "$build_status"
    fi
    exit "$restore_status"
  }
  trap restore_dev_binaries EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
fi

echo "=== Building macOS $arch ==="
npm run clean:build
TARGET_ARCH="$arch" npm run rebuild:native
# clean:build wiped dist-operon-runtime; rebuild the runtime JS bundles + the native
# addons that electron-builder packages as the `operon-runtime` extraResource.
# Arch-specific, so it must run per arch, after clean:build. build:native-addons
# cross-compiles for x86_64 when TARGET_ARCH=x64.
TARGET_ARCH="$arch" npm run build:operon-runtime
TARGET_ARCH="$arch" npm run build:native-addons
# cua-driver is the Computer Use engine: an upstream release binary, not built
# here. Upstream ships it universal; the fetch script thins it to TARGET_ARCH,
# which halves it, so this is per-arch like the addons above. Skipping this
# ships an app with no Computer Use engine.
TARGET_ARCH="$arch" npm run fetch:cua-driver
vite build
electron-builder --mac --config "$builder_config" --publish never

# Both architectures write release/latest-mac.yml. Keep the ARM one under its own
# name so the two never collide, in one tree locally or in one CI artifact folder.
if [ "$arch" = arm64 ]; then
  mv release/latest-mac.yml release/latest-mac-arm64.yml
fi

echo "=== macOS $arch done ==="
