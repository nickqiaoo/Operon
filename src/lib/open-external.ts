/**
 * Open an external URL the right way for the current build target:
 *  - Electron: hand off to the OS default browser via the main process.
 *  - Web: open a new browser tab (no electronAPI bridge exists there).
 *
 * Centralizes the fallback so every link site degrades gracefully on the web
 * build instead of silently no-opping `window.electronAPI?.openExternal(...)`.
 */
export function openExternalUrl(url: string): void {
  if (typeof window !== "undefined" && window.electronAPI?.openExternal) {
    void window.electronAPI.openExternal(url)
    return
  }
  window.open(url, "_blank", "noopener,noreferrer")
}
