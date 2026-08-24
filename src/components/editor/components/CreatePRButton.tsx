import { useCallback, useEffect, useMemo, useState } from "react"
import { useIntl } from "react-intl"
import { Loader2, GitPullRequest } from "lucide-react"
import { useProjectStore } from "@/stores/project-store"
import { api } from "@/lib/api"
import { CreatePRDialog } from "./CreatePRDialog"

export type RepoStatus = {
  isRepo: boolean
  remoteName: string | null
  owner: string | null
  repo: string | null
  currentBranch: string | null
  defaultBranch: string | null
  ahead: number
  behind: number
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  changedFiles: string[]
}

export function CreatePRButton() {
  const intl = useIntl()
  const projects = useProjectStore((s) => s.projects)
  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)

  const repoPath = useMemo(() => {
    if (!activeWorkspaceId) return null
    for (const project of projects) {
      const workspace = project.workspaces.find((w) => w.id === activeWorkspaceId)
      if (workspace) return workspace.worktreePath || project.rootPath
    }
    return null
  }, [projects, activeWorkspaceId])

  const [configured, setConfigured] = useState<boolean | null>(null)
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)

  const refresh = useCallback(async () => {
    if (!repoPath) return
    setLoading(true)
    try {
      const configRes = await api.integrationGithubGet()
      setConfigured(configRes.configured)
      if (!configRes.configured) {
        setStatus(null)
        return
      }
      const res = await api.integrationGithubRepoStatus(repoPath)
      setStatus(res)
    } catch {
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [repoPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (configured === null || !configured || !status || !status.isRepo || !status.owner || !status.repo) {
    return null
  }

  const changeCount =
    status.stagedCount + status.unstagedCount + status.untrackedCount
  const nothingToPublish = changeCount === 0 && status.ahead === 0

  const label = nothingToPublish
    ? intl.formatMessage({ id: "editor.pr.noChanges", defaultMessage: "No changes to publish" })
    : changeCount > 0
    ? intl.formatMessage({ id: "editor.pr.createFiles", defaultMessage: "Create PR · {count, plural, one {# file} other {# files}}" }, { count: changeCount })
    : intl.formatMessage({ id: "editor.pr.createCommits", defaultMessage: "Create PR · {count, plural, one {# commit ahead} other {# commits ahead}}" }, { count: status.ahead })
  const compactLabel = nothingToPublish
    ? intl.formatMessage({ id: "editor.pr.noChangesCompact", defaultMessage: "No changes" })
    : intl.formatMessage({ id: "editor.pr.createCompact", defaultMessage: "Create PR" })

  return (
    <>
      <button
        type="button"
        onClick={() => {
          void refresh()
          setDialogOpen(true)
        }}
        disabled={nothingToPublish || loading}
        aria-label={label}
        className={
          "inline-flex h-8 min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-full border px-3 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 @max-[460px]:size-8 @max-[460px]:justify-center @max-[460px]:gap-0 @max-[460px]:px-0 " +
          (nothingToPublish
            ? "border-border/40 bg-background/40 text-muted-foreground/60 cursor-not-allowed"
            : "border-border/50 bg-background/60 text-foreground hover:bg-muted/60 hover:border-border")
        }
        title={`${label} — ${status.owner}/${status.repo}`}
      >
        {loading ? (
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : (
          <GitPullRequest aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="min-w-0 truncate @max-[680px]:hidden">{label}</span>
        <span className="hidden shrink-0 @max-[680px]:inline @max-[460px]:hidden">{compactLabel}</span>
      </button>
      {repoPath && (
        <CreatePRDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          repoPath={repoPath}
          status={status}
          onDone={() => {
            setDialogOpen(false)
            void refresh()
          }}
        />
      )}
    </>
  )
}
