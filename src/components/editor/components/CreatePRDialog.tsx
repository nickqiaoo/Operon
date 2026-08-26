import { useEffect, useState } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { ExternalLink, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { GithubIcon } from "@/components/icons/GithubIcon"
import { api } from "@/lib/api"
import type { RepoStatus } from "./CreatePRButton"

const inputCn =
  "w-full px-3 py-2 text-sm bg-muted/30 rounded-xl border border-transparent hover:bg-muted/50 focus:bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40 transition-colors"

const textareaCn =
  "w-full px-3 py-2 text-sm bg-muted/30 rounded-xl border border-transparent hover:bg-muted/50 focus:bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40 font-mono resize-none transition-colors"

interface CreatePRDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoPath: string
  status: RepoStatus
  onDone: () => void
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

function defaultBranchName(title: string): string {
  const slug = slugify(title)
  const stamp = new Date().toISOString().slice(5, 10).replace("-", "")
  return `ai/${slug || "change"}-${stamp}`
}

export function CreatePRDialog({
  open,
  onOpenChange,
  repoPath,
  status,
  onDone,
}: CreatePRDialogProps) {
  const intl = useIntl()
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [branchName, setBranchName] = useState("")
  const [baseBranch, setBaseBranch] = useState("")
  const [commitMessage, setCommitMessage] = useState("")
  const [draft, setDraft] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const hasUncommitted =
    status.stagedCount + status.unstagedCount + status.untrackedCount > 0

  const canPushCurrent =
    !!status.currentBranch && status.currentBranch !== status.defaultBranch

  useEffect(() => {
    if (!open) return
    const initialTitle = status.currentBranch && canPushCurrent
      ? status.currentBranch.replace(/[-_]/g, " ")
      : ""
    setTitle(initialTitle)
    setBody("")
    setBaseBranch(status.defaultBranch ?? "main")
    setBranchName(
      canPushCurrent && status.currentBranch
        ? status.currentBranch
        : defaultBranchName(initialTitle || "change"),
    )
    setCommitMessage(hasUncommitted ? intl.formatMessage({ id: "editor.prDialog.defaultCommit", defaultMessage: "AI changes from chat" }) : "")
    setDraft(false)
  }, [open, status, canPushCurrent, hasUncommitted])

  useEffect(() => {
    if (!open) return
    if (canPushCurrent) return
    setBranchName(defaultBranchName(title))
  }, [title, open, canPushCurrent])

  const handleSubmit = async () => {
    if (!title.trim() || !branchName.trim() || !baseBranch.trim()) return
    if (hasUncommitted && !commitMessage.trim()) return
    setSubmitting(true)
    try {
      const res = await api.integrationGithubCreatePR({
        repoPath,
        title: title.trim(),
        body,
        branchName: branchName.trim(),
        baseBranch: baseBranch.trim(),
        commitMessage: hasUncommitted ? commitMessage.trim() : undefined,
        draft,
      })
      toast.success(
        <div className="flex items-center gap-2">
          <span><FormattedMessage id="editor.prDialog.created" defaultMessage="PR #{number} created" values={{ number: res.pr.number }} /></span>
          <a
            href={res.pr.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <FormattedMessage id="editor.openLink" defaultMessage="Open" /> <ExternalLink className="h-3 w-3" />
          </a>
        </div>,
      )
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : intl.formatMessage({ id: "editor.prDialog.createFailed", defaultMessage: "Failed to create PR" }))
    } finally {
      setSubmitting(false)
    }
  }

  const submitDisabled =
    submitting ||
    !title.trim() ||
    !branchName.trim() ||
    !baseBranch.trim() ||
    (hasUncommitted && !commitMessage.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GithubIcon className="h-5 w-5" />
            <FormattedMessage id="editor.prDialog.title" defaultMessage="Create Pull Request" />
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
            <div>
              <span className="font-semibold">{status.owner}/{status.repo}</span>
            </div>
            <div>
              {hasUncommitted ? (
                <FormattedMessage
                  id="editor.prDialog.willCommit"
                  defaultMessage="Will commit {count, plural, one {# file} other {# files}}: {files}"
                  values={{
                    count: status.stagedCount + status.unstagedCount + status.untrackedCount,
                    files: status.changedFiles.slice(0, 4).join(", ")
                      + (status.changedFiles.length > 4
                        ? intl.formatMessage({ id: "editor.prDialog.andMore", defaultMessage: " +{count} more" }, { count: status.changedFiles.length - 4 })
                        : ""),
                  }}
                />
              ) : status.ahead > 0 ? (
                <FormattedMessage
                  id="editor.prDialog.pushingAhead"
                  defaultMessage="Pushing {count, plural, one {# commit} other {# commits}} ahead of base"
                  values={{ count: status.ahead }}
                />
              ) : (
                <FormattedMessage id="editor.prDialog.noChanges" defaultMessage="No changes detected" />
              )}
            </div>
            <div className="text-muted-foreground/80">
              {canPushCurrent
                ? intl.formatMessage(
                    { id: "editor.prDialog.willPush", defaultMessage: "Will push {branch} to origin and open PR against {base}." },
                    { branch: branchName || status.currentBranch, base: baseBranch || "main" },
                  )
                : intl.formatMessage(
                    { id: "editor.prDialog.willCreate", defaultMessage: "Will create branch {branch} from HEAD, push to origin, and open PR against {base}." },
                    { branch: branchName || "<branch>", base: baseBranch || "main" },
                  )}
            </div>
          </div>

          <Field label={intl.formatMessage({ id: "editor.field.title", defaultMessage: "Title" })}>
            <input
              className={inputCn}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={intl.formatMessage({ id: "editor.prDialog.titlePlaceholder", defaultMessage: "PR title" })}
              spellCheck={false}
            />
          </Field>

          <Field label={intl.formatMessage({ id: "editor.field.description", defaultMessage: "Description" })}>
            <textarea
              className={textareaCn}
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={intl.formatMessage({ id: "editor.prDialog.descPlaceholder", defaultMessage: "What does this PR do? (Markdown supported)" })}
              spellCheck={false}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={intl.formatMessage({ id: "editor.prDialog.fieldBaseBranch", defaultMessage: "Base Branch" })}>
              <input
                className={inputCn}
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder="main"
                spellCheck={false}
              />
            </Field>
            <Field label={intl.formatMessage({ id: "editor.prDialog.fieldBranchName", defaultMessage: "Branch Name" })}>
              <input
                className={inputCn}
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="feature/my-change"
                spellCheck={false}
              />
            </Field>
          </div>

          {hasUncommitted && (
            <Field label={intl.formatMessage({ id: "editor.prDialog.fieldCommitMessage", defaultMessage: "Commit Message" })}>
              <input
                className={inputCn}
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder={intl.formatMessage({ id: "editor.prDialog.commitPlaceholder", defaultMessage: "Describe the change in one line" })}
                spellCheck={false}
              />
            </Field>
          )}

          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border/50"
            />
            <FormattedMessage id="editor.prDialog.openAsDraft" defaultMessage="Open as draft" />
          </label>
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={handleSubmit} disabled={submitDisabled}>
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <FormattedMessage id="editor.prDialog.create" defaultMessage="Create PR" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">
        {label}
      </label>
      {children}
    </div>
  )
}
