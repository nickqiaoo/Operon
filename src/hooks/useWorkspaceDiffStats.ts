import { useEffect, useMemo } from "react"
import { gitDiffRange } from "@/lib/api-client"
import { useProjectStore, type WorkspaceDiffStat } from "@/stores/project-store"
import { useStreamingStore } from "@/stores/streaming-store"
import { projectSidebarEntries } from "@/components/project/workspace-groups"

/** Enough to keep a long sidebar from firing one git process per row all at once. */
const CONCURRENCY = 4

async function loadStat(worktreePath: string): Promise<WorkspaceDiffStat | null> {
  try {
    // Working tree against HEAD: what the agent changed and nobody committed yet.
    const files = await gitDiffRange(worktreePath, "HEAD", null)
    return files.reduce(
      (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
      { additions: 0, deletions: 0 },
    )
  } catch {
    // A worktree that is gone or not a repo just shows no count.
    return null
  }
}

/**
 * Keeps the sidebar's per-workspace +N/-N current: loads it for visible directory rows once
 * the list is known, again whenever a turn ends (that is when an agent's edits land),
 * and when the window comes back into focus (edits made outside the app).
 */
export function useWorkspaceDiffStats(): void {
  const projects = useProjectStore((s) => s.projects)
  const setWorkspaceDiffStats = useProjectStore((s) => s.setWorkspaceDiffStats)
  const streamingCount = useStreamingStore((s) => s.streamingTabIds.size)

  const pathsKey = useMemo(
    // Spec rows have no diff badge; their execution worktrees need no request.
    () => [...new Set(projects.flatMap((p) => projectSidebarEntries(p, [], []).workspaces.map((w) => w.worktreePath)).filter(Boolean))].sort().join("\n"),
    [projects],
  )

  useEffect(() => {
    if (!pathsKey) {
      setWorkspaceDiffStats({})
      return
    }
    const paths = pathsKey.split("\n")
    let cancelled = false

    const refresh = async () => {
      const queue = [...paths]
      const next: Record<string, WorkspaceDiffStat> = {}
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
          const stat = await loadStat(path)
          if (stat) next[path] = stat
        }
      }))
      if (!cancelled) setWorkspaceDiffStats(next)
    }

    void refresh()
    window.addEventListener("focus", refresh)
    return () => {
      cancelled = true
      window.removeEventListener("focus", refresh)
    }
    // streamingCount: re-read as turns start and end, so finished edits show up.
  }, [pathsKey, streamingCount, setWorkspaceDiffStats])
}
