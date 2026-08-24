#!/bin/bash
set -e

REPO="Nickqiaoo/Operon"
RELEASE_DIR="release"
CHANGELOG_FILE="CHANGELOG.md"
KV_NAMESPACE_ID="be4369e5b2974929a70a0d8478ed80cd"
KV_KEY="download:stable"

# Read version from package.json
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
NOTES_FILE=$(mktemp)
CONFIG_FILE=$(mktemp)

cleanup() {
  rm -f "$NOTES_FILE"
  rm -f "$CONFIG_FILE"
}

trap cleanup EXIT

echo "Publishing ${TAG} to ${REPO}"

if [ ! -f "$CHANGELOG_FILE" ]; then
  echo "Error: changelog file not found: ${CHANGELOG_FILE}"
  exit 1
fi

node scripts/extract-release-notes.mjs "$VERSION" "$CHANGELOG_FILE" > "$NOTES_FILE"

# Collect release files (dmg, zip, blockmap, yml)
FILES=()
for f in \
  "${RELEASE_DIR}/Operon-${VERSION}-arm64.dmg" \
  "${RELEASE_DIR}/Operon-${VERSION}-arm64.dmg.blockmap" \
  "${RELEASE_DIR}/Operon-${VERSION}-arm64-mac.zip" \
  "${RELEASE_DIR}/Operon-${VERSION}-arm64-mac.zip.blockmap" \
  "${RELEASE_DIR}/Operon-${VERSION}.dmg" \
  "${RELEASE_DIR}/Operon-${VERSION}.dmg.blockmap" \
  "${RELEASE_DIR}/Operon-${VERSION}-mac.zip" \
  "${RELEASE_DIR}/Operon-${VERSION}-mac.zip.blockmap" \
  "${RELEASE_DIR}/latest-mac.yml" \
  "${RELEASE_DIR}/latest-mac-arm64.yml"; do
  if [ -f "$f" ]; then
    FILES+=("$f")
  fi
done

if [ ${#FILES[@]} -eq 0 ]; then
  echo "Error: no release files found in ${RELEASE_DIR}/"
  exit 1
fi

echo "Found ${#FILES[@]} files to upload"

# Create or reuse a draft GitHub release first, so partial uploads are never public.
if gh release view "$TAG" --repo "$REPO" &>/dev/null; then
  RELEASE_IS_DRAFT=$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq '.isDraft')

  if [ "$RELEASE_IS_DRAFT" != "true" ]; then
    echo "Converting existing release ${TAG} to draft..."
    gh release edit "$TAG" --repo "$REPO" --draft
  fi

  echo "Updating draft release metadata from ${CHANGELOG_FILE}..."
  gh release edit "$TAG" --repo "$REPO" --title "Operon ${TAG}" --notes-file "$NOTES_FILE"
else
  echo "Creating draft release ${TAG}..."
  gh release create "$TAG" --repo "$REPO" --title "Operon ${TAG}" --draft --notes-file "$NOTES_FILE"
fi

# Upload files while the release is still a draft.
echo "Uploading assets to draft release..."
gh release upload "$TAG" --repo "$REPO" --clobber "${FILES[@]}"

echo "Publishing release ${TAG}..."
# `--prerelease=false` rather than dropping the flag: this path also runs against
# a release that already exists, and omitting the flag leaves whatever state it
# had, so a tag previously published as a prerelease would silently stay one.
gh release edit "$TAG" --repo "$REPO" --draft=false --title "Operon ${TAG}" --prerelease=false --notes-file "$NOTES_FILE"

# Update Cloudflare KV download config
echo "Updating Cloudflare KV..."

CONFIG=$(cat <<EOF
{
  "version": "${VERSION}",
  "github": {
    "owner": "Nickqiaoo",
    "repo": "Operon",
    "tagPrefix": "v"
  },
  "files": {
    "mac-arm64": "Operon-${VERSION}-arm64.dmg",
    "mac-x64": "Operon-${VERSION}.dmg"
  },
  "fallbacks": {
    "mac": "mac-arm64"
  },
  "defaultTarget": "mac-arm64"
}
EOF
)

printf '%s\n' "$CONFIG" > "$CONFIG_FILE"

# --remote is load-bearing. Since wrangler 4 `kv key put` defaults to the LOCAL
# simulator ("Resource location: local") and still exits 0, so without it this
# step printed "KV updated" while the live key never changed — the download page
# sat on 1.0.0-beta.3 across several releases before anyone noticed.
npx wrangler kv key put --namespace-id "$KV_NAMESPACE_ID" "$KV_KEY" --path "$CONFIG_FILE" --remote

# Read the key back and fail loudly on a mismatch, so a silent no-op can't be
# mistaken for a successful publish again.
echo "Verifying KV..."
KV_LIVE_VERSION=$(npx wrangler kv key get --namespace-id "$KV_NAMESPACE_ID" "$KV_KEY" --remote 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=s.indexOf("{");try{console.log(JSON.parse(s.slice(i)).version??"")}catch{console.log("")}})')

if [ "$KV_LIVE_VERSION" != "$VERSION" ]; then
  echo "Error: KV still reports '${KV_LIVE_VERSION:-<unreadable>}', expected '${VERSION}'."
  echo "       The GitHub release IS published; only the download-page pointer failed."
  exit 1
fi

echo "Done! Release ${TAG} published and KV verified at ${KV_LIVE_VERSION}."
