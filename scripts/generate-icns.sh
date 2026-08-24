#!/bin/bash
# Generate build/icon.icns from src/assets/icon/logo.png
# Uses electron-builder's app-builder to avoid SVG and iconutil quirks.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
SOURCE_PNG="$ROOT/src/assets/icon/logo.png"
OUTPUT_DIR="$ROOT/build/.icon-icns"
ICNS="$ROOT/build/icon.icns"
APP_BUILDER="$(cd "$ROOT" && node -e "process.stdout.write(require('app-builder-bin').appBuilderPath)")"

if [ ! -f "$SOURCE_PNG" ]; then
  echo "Missing source icon: $SOURCE_PNG" >&2
  exit 1
fi

echo "Generating icns from $SOURCE_PNG ..."
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

echo "Using app-builder: $APP_BUILDER"
"$APP_BUILDER" icon \
  --format icns \
  --root "$ROOT" \
  --input "$SOURCE_PNG" \
  --out "$OUTPUT_DIR" > /dev/null

cp "$OUTPUT_DIR/icon.icns" "$ICNS"
rm -rf "$OUTPUT_DIR"

echo "Done: $ICNS"
