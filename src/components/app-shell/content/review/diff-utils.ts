import { prepareFileTreeInput } from "@pierre/trees"
import type { FileChange } from "./types"

export const joinPath = (root: string, leaf: string) =>
  `${root.replace(/[\\/]+$/, "")}/${leaf.replace(/^[/\\]+/, "")}`

export const isUntracked = (entry: { status: string; index: string; workingDir: string }) =>
  entry.status === "?" || entry.index === "?" || entry.workingDir === "?"

/** Build a synthetic unified diff for an untracked (new) file. */
export const buildUntrackedDiff = (relativePath: string, content: string): string => {
  const lines = content.split(/\r?\n/)
  const safePath = relativePath.replace(/\\/g, "/")
  const header = [
    `diff --git a/${safePath} b/${safePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${safePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ]
  const body = lines.map((line) => `+${line}`)
  return [...header, ...body].join("\n")
}

export const countDiffMetrics = (diff: string) => {
  let additions = 0
  let deletions = 0
  let changedBytes = 0
  let maxChangedLineBytes = 0
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const changedLineBytes = line.length - 1
      additions += 1
      changedBytes += changedLineBytes
      maxChangedLineBytes = Math.max(maxChangedLineBytes, changedLineBytes)
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      const changedLineBytes = line.length - 1
      deletions += 1
      changedBytes += changedLineBytes
      maxChangedLineBytes = Math.max(maxChangedLineBytes, changedLineBytes)
    }
  }
  return { additions, deletions, changedBytes, maxChangedLineBytes }
}

/**
 * Split a combined `git diff` patch (many files, as emitted by `git diff`
 * without a path filter) into per-file unified patches keyed by the new path.
 *
 * Loading the review this way is a single git round-trip for the whole tree
 * instead of one `git diff -- <path>` per file (the previous N+1). Paths git
 * C-quotes (spaces / non-ASCII) are ambiguous to parse from the header, so we
 * skip them here and let `mapEntryPatches` resolve them with a per-file fetch —
 * correctness never depends on the fast batched path.
 */
export const splitCombinedDiff = (combined: string): Map<string, string> => {
  const map = new Map<string, string>()
  if (combined.trim().length === 0) return map
  // Each file section starts at a line beginning with "diff --git ".
  const sections = combined.split(/\n(?=diff --git )/)
  for (const section of sections) {
    if (!section.startsWith("diff --git ")) continue
    const firstLineEnd = section.indexOf("\n")
    const header = firstLineEnd === -1 ? section : section.slice(0, firstLineEnd)
    if (header.includes('"')) continue // quoted path → per-file fallback
    const match = header.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (match == null) continue
    // The b-side is the new path (== old path for edits / deletes / binaries).
    map.set(match[2], section)
  }
  return map
}

/**
 * Resolve a per-file patch for each entry from one combined diff, filling any
 * misses (quoted paths, unusual renames) with a targeted per-file fetch. The
 * common case is a single git call for all files; misses are rare.
 */
export async function mapEntryPatches(
  entries: { path: string }[],
  combined: string,
  fetchOne: (path: string) => Promise<string>,
): Promise<Map<string, string>> {
  const map = splitCombinedDiff(combined)
  const misses = entries.filter((entry) => !map.has(entry.path))
  if (misses.length > 0) {
    const fetched = await Promise.all(
      misses.map(async (entry) => [entry.path, await fetchOne(entry.path).catch(() => "")] as const),
    )
    for (const [path, diff] of fetched) {
      if (diff.length > 0) map.set(path, diff)
    }
  }
  return map
}

/**
 * Codex renders the review list in the file tree's canonical order. Reuse
 * Pierre's tree preparation here so the diff list and right-side tree are
 * driven by the same directory-first ordering.
 */
export const sortFileChangesInTreeOrder = (files: FileChange[]): FileChange[] => {
  const filesByPath = new Map(files.map((file) => [file.path, file]))
  const prepared = prepareFileTreeInput(
    files.map((file) => file.path),
    {
      flattenEmptyDirectories: true,
    },
  )
  const ordered: FileChange[] = []
  for (const path of prepared.paths) {
    const file = filesByPath.get(path)
    if (file != null) ordered.push(file)
  }
  return ordered
}

/** Codex-only patches use a `@@` header — prepend file headers if missing. */
export const normalizePatch = (path: string, diff: string): string => {
  const trimmed = diff.trimStart()
  if (trimmed.length === 0 || trimmed.startsWith("diff ") || trimmed.startsWith("---")) {
    return diff
  }
  if (trimmed.startsWith("@@")) {
    return `--- a/${path}\n+++ b/${path}\n${diff}`
  }
  return diff
}

