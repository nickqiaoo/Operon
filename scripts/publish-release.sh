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
RELEASE_TARGET="${RELEASE_TARGET:-}"
WRANGLER=(npx wrangler)

if [ -n "$RELEASE_TARGET" ]; then
  : "${CLOUDFLARE_API_TOKEN:?Missing Cloudflare API token}"
  : "${CLOUDFLARE_ACCOUNT_ID:?Missing Cloudflare account ID}"
  command -v wrangler >/dev/null
  WRANGLER=(wrangler)
fi

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
  if [ -n "$RELEASE_TARGET" ] && [ ! -s "$f" ]; then
    echo "Error: missing or empty release asset: $f" >&2
    exit 1
  elif [ -f "$f" ]; then
    FILES+=("$f")
  fi
done

if [ ${#FILES[@]} -eq 0 ]; then
  echo "Error: no release files found in ${RELEASE_DIR}/"
  exit 1
fi

echo "Found ${#FILES[@]} files to upload"

# A release tag created by CI must identify the exact commit that built these assets.
TAG_EXISTS=false
if [ -n "$RELEASE_TARGET" ]; then
  tag_refs=$(gh api "repos/$REPO/git/matching-refs/tags/$TAG" --jq '.[].ref')
  if grep -Fxq "refs/tags/$TAG" <<< "$tag_refs"; then
    TAG_EXISTS=true
    tag_commit=$(gh api "repos/$REPO/commits/$TAG" --jq '.sha')
    if [ "$tag_commit" != "$RELEASE_TARGET" ]; then
      echo "Error: $TAG already points to a different commit." >&2
      exit 1
    fi
  fi
fi

# Create or reuse a draft GitHub release first, so partial uploads are never public.
PUBLISH_RELEASE=true
if RELEASE_STATE=$(gh release view "$TAG" --repo "$REPO" --json isDraft,isPrerelease,targetCommitish \
  --jq '[.isDraft, .isPrerelease, .targetCommitish] | @tsv' 2>/dev/null); then
  IFS=$'\t' read -r RELEASE_IS_DRAFT RELEASE_IS_PRERELEASE EXISTING_TARGET <<< "$RELEASE_STATE"
  if [ -n "$RELEASE_TARGET" ] && [ "$TAG_EXISTS" = false ] \
    && [ "$EXISTING_TARGET" != "$RELEASE_TARGET" ]; then
    echo "Error: release $TAG targets a different commit." >&2
    exit 1
  fi

  if [ -n "$RELEASE_TARGET" ] && [ "$RELEASE_IS_DRAFT" != true ]; then
    if [ "$RELEASE_IS_PRERELEASE" = true ]; then
      echo "Error: release $TAG is already published as a prerelease." >&2
      exit 1
    fi
    # A retry after a KV failure can reuse a complete published release.
    published_assets=$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[] | select(.size > 0) | .name')
    for f in "${FILES[@]}"; do
      if ! grep -Fxq "${f##*/}" <<< "$published_assets"; then
        echo "Error: published release $TAG is missing ${f##*/}." >&2
        exit 1
      fi
    done
    PUBLISH_RELEASE=false
    echo "Release $TAG is already published. Continuing with Cloudflare KV."
  elif [ "$RELEASE_IS_DRAFT" != true ]; then
    echo "Converting existing release ${TAG} to draft..."
    gh release edit "$TAG" --repo "$REPO" --draft
  fi

  if [ "$PUBLISH_RELEASE" = true ]; then
    echo "Updating draft release metadata from ${CHANGELOG_FILE}..."
    gh release edit "$TAG" --repo "$REPO" --title "Operon ${TAG}" --notes-file "$NOTES_FILE"
  fi
else
  echo "Creating draft release ${TAG}..."
  target_args=()
  if [ -n "$RELEASE_TARGET" ]; then
    target_args=(--target "$RELEASE_TARGET")
  fi
  gh release create "$TAG" --repo "$REPO" --title "Operon ${TAG}" --draft --notes-file "$NOTES_FILE" ${target_args[@]+"${target_args[@]}"}
fi

if [ "$PUBLISH_RELEASE" = true ]; then
  echo "Uploading assets to draft release..."
  gh release upload "$TAG" --repo "$REPO" --clobber "${FILES[@]}"

  echo "Publishing release ${TAG}..."
  # Explicitly clear the prerelease flag when publishing an existing draft.
  gh release edit "$TAG" --repo "$REPO" --draft=false --title "Operon ${TAG}" --prerelease=false --notes-file "$NOTES_FILE"
fi

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
#
# Retried because wrangler refreshes an expired OAuth token right before the
# request, and the freshly minted token can get a one-off 401 (code 10000).
for attempt in 1 2 3; do
  if "${WRANGLER[@]}" kv key put --namespace-id "$KV_NAMESPACE_ID" "$KV_KEY" --path "$CONFIG_FILE" --remote; then
    break
  fi
  if [ "$attempt" -eq 3 ]; then
    echo "Error: KV put failed after ${attempt} attempts."
    echo "       The GitHub release IS published; only the download-page pointer failed."
    exit 1
  fi
  echo "KV put failed (attempt ${attempt}), retrying in 5s..."
  sleep 5
done

# Read the key back and fail loudly on a mismatch, so a silent no-op can't be
# mistaken for a successful publish again.
echo "Verifying KV..."
KV_LIVE_VERSION=$("${WRANGLER[@]}" kv key get --namespace-id "$KV_NAMESPACE_ID" "$KV_KEY" --remote 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=s.indexOf("{");try{console.log(JSON.parse(s.slice(i)).version??"")}catch{console.log("")}})')

if [ "$KV_LIVE_VERSION" != "$VERSION" ]; then
  echo "Error: KV still reports '${KV_LIVE_VERSION:-<unreadable>}', expected '${VERSION}'."
  echo "       The GitHub release IS published; only the download-page pointer failed."
  exit 1
fi

echo "Done! Release ${TAG} published and KV verified at ${KV_LIVE_VERSION}."
