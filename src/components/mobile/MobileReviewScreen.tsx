import { useCallback, useMemo, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Check, CircleDashed, FileDiff, GitCommitHorizontal, History } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { api } from "@/lib/api"
import type { GitCommitEntry } from "@/lib/api-client"
import { gitKeys, useGitCommits, useGitStatus } from "@/lib/git-queries"
import { queryClient } from "@/lib/query-client"
import { cn } from "@/lib/utils"
import { loadRangeFiles } from "@/components/app-shell/content/review/load-review"
import { MobileDiffBrowser } from "./MobileDiffBrowser"
import { MobileHeader, useMobileContentBottom, useMobileContentOffset, useMobileTopInset } from "./MobileHeader"
import { MobileSheet } from "./MobileSheet"

interface ChangedFile {
  path: string
  status: string
  index: string
  workingDir: string
}

/** A file as the browser lists it: a working-tree entry, or one file of a commit (patch already loaded). */
type ReviewFile =
  | ({ kind: "worktree" } & ChangedFile)
  | { kind: "commit"; path: string; status: string; diff: string; additions: number; deletions: number }

interface MobileReviewScreenProps {
  /** Active workspace's git worktree path, or null when none is selected. */
  worktreePath: string | null
}

/**
 * Read-only "what changed" view for the active workspace: the uncommitted
 * changes by default, or one commit's changes (parent → commit) picked from the
 * source row at the top of the list. Each file's unified diff renders with the
 * same `@pierre/diffs` `PatchDiff` component the desktop ReviewTab uses, so the
 * phone shows identical syntax highlighting and +/- styling. We stop at the
 * patch renderer though: the desktop's full-file expand, large-diff capping,
 * file tree and staging machinery don't fit a phone. Editing/staging stays on
 * desktop.
 */
export function MobileReviewScreen({ worktreePath }: MobileReviewScreenProps) {
  const intl = useIntl()
  const topInset = useMobileTopInset()
  const contentOffset = useMobileContentOffset()
  const contentBottom = useMobileContentBottom()
  const root = worktreePath ?? ""

  // The picked commit belongs to the workspace it was picked in: switching
  // workspaces falls back to that workspace's uncommitted changes.
  const [commitPick, setCommitPick] = useState<{ root: string; sha: string } | null>(null)
  const commitSha = commitPick && commitPick.root === worktreePath ? commitPick.sha : null
  const [pickerOpen, setPickerOpen] = useState(false)

  // Keyed by worktree: switching workspaces shows that workspace's last known
  // status (or the loading state), never the previous one's files.
  const statusQuery = useGitStatus(root, { enabled: !!worktreePath && commitSha == null })
  const commitsQuery = useGitCommits(root, { enabled: !!worktreePath && (pickerOpen || commitSha != null) })
  const commitFilesQuery = useQuery({
    queryKey: gitKeys.commitFiles(root, commitSha ?? ""),
    queryFn: async () => {
      const sha = commitSha ?? ""
      const parent = await api.gitCommitParent(root, sha)
      return loadRangeFiles(root, parent, sha)
    },
    enabled: !!worktreePath && commitSha != null,
    staleTime: 60_000,
  })
  const selectedCommit = commitSha ? commitsQuery.data?.find((c) => c.sha === commitSha) ?? null : null

  // A fresh array per successful fetch (not only when the list changes) so the
  // diff browser reloads diffs after a refresh even if the file list is the same.
  const { data: status, dataUpdatedAt } = statusQuery
  const { data: commitFiles } = commitFilesQuery
  const files = useMemo<ReviewFile[]>(() => {
    if (commitSha != null) {
      return (commitFiles ?? []).map((f) => ({
        kind: "commit",
        path: f.path,
        status: f.status,
        diff: f.diff,
        additions: f.additions,
        deletions: f.deletions,
      }))
    }
    return (status?.files ?? []).map((f) => ({
      kind: "worktree",
      path: f.path,
      status: f.status,
      index: f.index,
      workingDir: f.workingDir,
    }))
  }, [commitSha, commitFiles, status, dataUpdatedAt])

  const activeQuery = commitSha != null ? commitFilesQuery : statusQuery
  const error = activeQuery.isError
    ? commitSha != null
      ? intl.formatMessage({ id: "mobile.changes.commitLoadError", defaultMessage: "Couldn't load this commit." })
      : intl.formatMessage({ id: "mobile.changes.loadError", defaultMessage: "Couldn't load changes." })
    : null

  // Refresh drops the cached status and every cached diff for this repo.
  const refresh = useCallback(() => {
    if (worktreePath) void queryClient.invalidateQueries({ queryKey: gitKeys.all(worktreePath) })
  }, [worktreePath])

  const loadDiff = useCallback((file: ReviewFile) => {
    if (file.kind === "commit") return Promise.resolve(file.diff)
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
    <>
      <MobileDiffBrowser
        title={<FormattedMessage id="mobile.changes.title" defaultMessage="Changes" />}
        files={files}
        loadDiff={loadDiff}
        loading={activeQuery.isPending}
        refreshing={activeQuery.isFetching}
        error={error}
        emptyTitle={
          commitSha != null
            ? <FormattedMessage id="mobile.changes.commitEmptyTitle" defaultMessage="No file changes" />
            : <FormattedMessage id="mobile.changes.emptyTitle" defaultMessage="No changes" />
        }
        emptyDescription={
          commitSha != null
            ? <FormattedMessage id="mobile.changes.commitEmptyDesc" defaultMessage="This commit doesn't change any files." />
            : <FormattedMessage id="mobile.changes.emptyDesc" defaultMessage="The working tree is clean." />
        }
        diffErrorMessage={intl.formatMessage({ id: "mobile.changes.diffError", defaultMessage: "Couldn't load diff." })}
        onRefresh={refresh}
        renderHeader={(actions) => <MobileHeader actions={actions} />}
        extraActions={[{
          id: "pickSource",
          label: intl.formatMessage({ id: "mobile.changes.pickSource", defaultMessage: "Choose which changes to show" }),
          icon: <History className="size-3.5" />,
          symbol: "clock.arrow.circlepath",
          onClick: () => setPickerOpen(true),
        }]}
        listHeader={
          <SourceLabel
            commitSha={commitSha}
            commit={selectedCommit}
            onOpen={() => setPickerOpen(true)}
          />
        }
        topInset={topInset}
        contentOffset={contentOffset}
        contentBottom={contentBottom}
      />
      <CommitPickerSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        commits={commitsQuery.data ?? []}
        loading={commitsQuery.isPending}
        error={commitsQuery.isError}
        selectedSha={commitSha}
        onSelect={(sha) => {
          setCommitPick(sha == null ? null : { root, sha })
          setPickerOpen(false)
        }}
      />
    </>
  )
}

/**
 * What the list is showing, as a quiet section label rather than a control —
 * switching (including back to the uncommitted changes) happens in the picker
 * the header's history button opens; tapping the label opens it too.
 */
function SourceLabel({
  commitSha,
  commit,
  onOpen,
}: {
  commitSha: string | null
  commit: GitCommitEntry | null
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full min-w-0 shrink-0 truncate px-3 pt-1 pb-1.5 text-left text-xs font-medium text-muted-foreground/80"
    >
      {commitSha == null ? (
        <FormattedMessage id="mobile.changes.uncommitted" defaultMessage="Uncommitted changes" />
      ) : (
        <>
          <span className="font-mono">{commit?.shortSha ?? commitSha.slice(0, 7)}</span>
          {commit ? <> · {commit.subject}</> : null}
        </>
      )}
    </button>
  )
}

/** Uncommitted changes first, then the recent commits on HEAD. `null` picks the working tree. */
function CommitPickerSheet({
  open,
  onClose,
  commits,
  loading,
  error,
  selectedSha,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  commits: GitCommitEntry[]
  loading: boolean
  error: boolean
  selectedSha: string | null
  onSelect: (sha: string | null) => void
}) {
  const intl = useIntl()
  return (
    <MobileSheet
      open={open}
      onClose={onClose}
      title={intl.formatMessage({ id: "mobile.changes.sourceTitle", defaultMessage: "Show changes from" })}
    >
      <PickerRow
        icon={<CircleDashed className="size-4 shrink-0 text-muted-foreground/70" />}
        title={<FormattedMessage id="mobile.changes.uncommitted" defaultMessage="Uncommitted changes" />}
        detail={<FormattedMessage id="mobile.changes.workingTree" defaultMessage="Working tree" />}
        active={selectedSha == null}
        onClick={() => onSelect(null)}
      />
      {loading ? (
        <p className="px-3 py-6 text-center text-[13px] text-muted-foreground/70">
          <FormattedMessage id="common.loading" defaultMessage="Loading…" />
        </p>
      ) : error ? (
        <p className="px-3 py-6 text-center text-[13px] text-destructive">
          <FormattedMessage id="mobile.changes.commitsError" defaultMessage="Couldn't load commits." />
        </p>
      ) : commits.length === 0 ? (
        <p className="px-3 py-6 text-center text-[13px] text-muted-foreground/70">
          <FormattedMessage id="review.noCommitsFound" defaultMessage="No commits found." />
        </p>
      ) : (
        <div className="mt-0.5 space-y-0.5">
          {commits.map((c) => (
            <PickerRow
              key={c.sha}
              icon={<GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground/70" />}
              title={c.subject}
              detail={<><span className="font-mono">{c.shortSha}</span> · {c.authorName} · {c.relativeTime}</>}
              active={c.sha === selectedSha}
              onClick={() => onSelect(c.sha)}
            />
          ))}
        </div>
      )}
    </MobileSheet>
  )
}

/** One entry of the picker: icon, a title line and a muted detail line. */
function PickerRow({
  icon,
  title,
  detail,
  active,
  onClick,
}: {
  icon: ReactNode
  title: ReactNode
  detail: ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-row-hover",
        active && "bg-row-selected",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] text-foreground">{title}</span>
        <span className="block truncate text-xs text-muted-foreground/70">{detail}</span>
      </span>
      {active && <Check className="size-4 shrink-0 text-foreground/70" />}
    </button>
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
