// A lazily loaded chunk can disappear under a running page: on web a new deploy
// replaces the hashed files the open tab still points at. The import then fails
// with "Failed to fetch dynamically imported module" and the feature is dead
// until a reload — so reload once for the user, and never loop if it keeps failing.
//
// Not a fix for the dev-server variant: when Vite re-optimizes deps it can rename
// shared chunks while keeping the same `?v=` browserHash, and it serves deps as
// `immutable`, so a plain reload reuses the cached importer that still names the
// old chunk. That needs a cache-bypassing reload (⌘⇧R) or a `vite --force` restart.

const LAST_RELOAD_KEY = 'operon:stale-chunk-reload-at'
// A reload that fails again within this window is a real error, not a stale tab.
const RELOAD_COOLDOWN_MS = 10_000

const CHUNK_ERROR_PATTERNS = [
  'Failed to fetch dynamically imported module', // Chromium
  'Importing a module script failed', // Safari / WKWebView
  'error loading dynamically imported module', // Firefox
  'Unable to preload CSS', // Vite's preload helper
]

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return CHUNK_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
}

/** Reloads the page unless we already did so moments ago. Returns whether it reloaded. */
export function reloadForStaleChunk(): boolean {
  // localStorage, not sessionStorage: an installed iOS PWA can drop
  // sessionStorage across a reload, which would defeat the loop guard.
  try {
    const last = Number(localStorage.getItem(LAST_RELOAD_KEY) ?? 0)
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false
    localStorage.setItem(LAST_RELOAD_KEY, String(Date.now()))
  } catch {
    // Without storage there is no loop guard, so leave the error visible.
    return false
  }
  window.location.reload()
  return true
}

export function installStaleChunkReload(): void {
  // Fired by Vite's preload helper in production builds when a dynamic import
  // (or its CSS) fails. preventDefault stops the error from propagating.
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForStaleChunk()) event.preventDefault()
  })
}
