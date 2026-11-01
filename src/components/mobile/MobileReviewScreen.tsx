import { useCallback, useMemo } from "react"
import { FileDiff } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { api } from "@/lib/api"
import { gitKeys, useGitStatus } from "@/lib/git-queries"
import { queryClient } from "@/lib/query-client"
import { MobileDiffBrowser } from "./MobileDiffBrowser"
import { MobileHeader, useMobileContentBottom, useMobileContentOffset, useMobileTopInset } from "./MobileHeader"

interface ChangedFile {
  path: string
  status: string
  index: string
  workingDir: string
}

interface MobileReviewScreenProps {
  /** Active workspace's git worktree path, or null when none is selected. */
  worktreePath: string | null
}

/**
 * Read-only "what changed" view for the active workspace. Reuses the existing
 * git API (`gitStatus` + `gitDiff`) and renders each file's unified diff with
 * the same `@pierre/diffs` `PatchDiff` component the desktop ReviewTab uses, so
 * the phone shows identical syntax highlighting and +/- styling. We stop at the
 * patch renderer though: the desktop's full-file expand, large-diff capping,
 * file tree and staging machinery don't fit a phone. Editing/staging stays on
 * desktop.
 */
export function MobileReviewScreen({ worktreePath }: MobileReviewScreenProps) {
  const intl = useIntl()
  const topInset = useMobileTopInset()
  const contentOffset = useMobileContentOffset()
  const contentBottom = useMobileContentBottom()
  // Keyed by worktree: switching workspaces shows that workspace's last known
  // status (or the loading state), never the previous one's files.
  const statusQuery = useGitStatus(worktreePath ?? "", { enabled: !!worktreePath })
  // A fresh array per successful fetch (not only when the list changes) so the
  // diff browser reloads diffs after a refresh even if the file list is the same.
  const { data: status, dataUpdatedAt } = statusQuery
  const files = useMemo<ChangedFile[]>(
    () => (status?.files ?? []).map((f) => ({ path: f.path, status: f.status, index: f.index, workingDir: f.workingDir })),
    [status, dataUpdatedAt],
  )
  const error = statusQuery.isError
    ? intl.formatMessage({ id: "mobile.changes.loadError", defaultMessage: "Couldn't load changes." })
    : null

  // Refresh drops the cached status and every cached diff for this repo.
  const refresh = useCallback(() => {
    if (worktreePath) void queryClient.invalidateQueries({ queryKey: gitKeys.all(worktreePath) })
  }, [worktreePath])

  const loadDiff = useCallback((file: ChangedFile) => {
    if (!worktreePath) return Promise.resolve("")
    return queryClient.fetchQuery({
      queryKey: gitKeys.fileDiff(worktreePath, file.path, `${file.status}|${file.index}|${file.workingDir}`),
      queryFn: () => loadFileDiff(worktreePath, file),
      staleTime: 5_000,
    })
  }, [worktreePath])

  if (!worktreePath) {
    return (
      <div className="flex h-full flex-col">
        <MobileHeader />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center" style={{ paddingTop: contentOffset }}>
          <FileDiff className="size-6 text-muted-foreground/60" />
          <p className="text-base font-medium text-foreground/85">
            <FormattedMessage id="mobile.changes.noWorkspaceTitle" defaultMessage="No workspace selected" />
          </p>
          <p className="text-[13px] text-muted-foreground/70">
            <FormattedMessage id="mobile.changes.noWorkspaceDesc" defaultMessage="Pick a workspace from the bar above." />
          </p>
        </div>
      </div>
    )
  }

  return (
    <MobileDiffBrowser
      title={<FormattedMessage id="mobile.changes.title" defaultMessage="Changes" />}
      files={files}
      loadDiff={loadDiff}
      loading={!!worktreePath && statusQuery.isPending}
      refreshing={statusQuery.isFetching}
      error={error}
      emptyTitle={<FormattedMessage id="mobile.changes.emptyTitle" defaultMessage="No changes" />}
      emptyDescription={<FormattedMessage id="mobile.changes.emptyDesc" defaultMessage="The working tree is clean." />}
      diffErrorMessage={intl.formatMessage({ id: "mobile.changes.diffError", defaultMessage: "Couldn't load diff." })}
      onRefresh={refresh}
      renderHeader={(actions) => <MobileHeader actions={actions} />}
      topInset={topInset}
      contentOffset={contentOffset}
      contentBottom={contentBottom}
    />
  )
}

const joinPath = (root: string, leaf: string) =>
  `${root.replace(/[\\/]+$/, "")}/${leaf.replace(/^[/\\]+/, "")}`

const hasIndexChange = (file: ChangedFile) => {
  const code = file.index.trim()
  return code.length > 0 && code !== "?"
}

const hasWorkingTreeChange = (file: ChangedFile) => {
  const code = file.workingDir.trim()
  return code.length > 0 && code !== "?"
}

const isUntracked = (file: ChangedFile) =>
  file.status === "?" || file.index === "?" || file.workingDir === "?"

function buildUntrackedDiff(relativePath: string, content: string): string {
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
  return [...header, ...lines.map((line) => `+${line}`)].join("\n")
}

async function loadFileDiff(worktreePath: string, file: ChangedFile): Promise<string> {
  if (isUntracked(file)) {
    const content = await api.readFile(joinPath(worktreePath, file.path))
    return buildUntrackedDiff(file.path, content)
  }

  const parts: string[] = []
  if (hasIndexChange(file)) {
    const cachedDiff = await api.gitDiff(worktreePath, file.path, true)
    if (cachedDiff.trim()) parts.push(cachedDiff)
  }
  if (hasWorkingTreeChange(file)) {
    const workingDiff = await api.gitDiff(worktreePath, file.path, false)
    if (workingDiff.trim()) parts.push(workingDiff)
  }

  if (parts.length > 0) return parts.join("\n")
  return api.gitDiff(worktreePath, file.path)
}
