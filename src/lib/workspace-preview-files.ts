/**
 * The set of files open in one workspace-browser tab's preview strip.
 *
 * `openPaths` is display order (left → right, in the order files were opened);
 * `recentPaths` is the same set ordered least → most recently viewed. Opening a
 * file past the cap closes the least recently viewed one — not the leftmost —
 * so a file you keep coming back to survives however early you opened it.
 */
export interface PreviewFiles {
  openPaths: string[]
  recentPaths: string[]
}

export const MAX_PREVIEW_FILES = 8

/**
 * Normalizes a payload that may predate the strip: a tab persisted with only
 * `selectedPath` starts with that one file open.
 */
export function previewFilesOf(payload: {
  selectedPath: string | null
  openPaths?: string[]
  recentPaths?: string[]
}): PreviewFiles {
  if (payload.openPaths != null && payload.openPaths.length > 0) {
    const open = new Set(payload.openPaths)
    const recent = (payload.recentPaths ?? []).filter((p) => open.has(p))
    // Anything open but missing from the recency list counts as oldest.
    const unranked = payload.openPaths.filter((p) => !recent.includes(p))
    return { openPaths: payload.openPaths, recentPaths: [...unranked, ...recent] }
  }
  return payload.selectedPath != null
    ? { openPaths: [payload.selectedPath], recentPaths: [payload.selectedPath] }
    : { openPaths: [], recentPaths: [] }
}

/** Show `path`: add it to the strip if needed, mark it most recent, evict past the cap. */
export function openPreviewFile(
  files: PreviewFiles,
  path: string,
  max: number = MAX_PREVIEW_FILES
): PreviewFiles {
  let openPaths = files.openPaths.includes(path) ? files.openPaths : [...files.openPaths, path]
  let recentPaths = [...files.recentPaths.filter((p) => p !== path), path]
  while (openPaths.length > max) {
    const evicted = recentPaths[0]
    recentPaths = recentPaths.slice(1)
    openPaths = openPaths.filter((p) => p !== evicted)
  }
  return { openPaths, recentPaths }
}

/**
 * Close `path`. When it was the file on screen, fall back to the most recently
 * viewed one still open (or nothing).
 */
export function closePreviewFile(
  files: PreviewFiles,
  path: string,
  selectedPath: string | null
): PreviewFiles & { selectedPath: string | null } {
  const openPaths = files.openPaths.filter((p) => p !== path)
  const recentPaths = files.recentPaths.filter((p) => p !== path)
  return {
    openPaths,
    recentPaths,
    selectedPath: selectedPath === path ? (recentPaths.at(-1) ?? null) : selectedPath,
  }
}
