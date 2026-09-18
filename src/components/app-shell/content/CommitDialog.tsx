import { useEffect, useState } from "react"
import { useIntl, FormattedMessage } from "react-intl"
import { ArrowUp, Check, ChevronDown, GitBranch, GitCommitHorizontal, Loader2, Plus, X } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { useGitStatus } from "@/lib/git-queries"
import { useGitWorkflow } from "./use-git-workflow"

const textareaCn =
  "w-full px-3 py-2 text-sm bg-background/50 rounded-xl border border-transparent hover:bg-background/70 focus:bg-background focus:outline-none focus:border-tint/40 focus:ring-1 focus:ring-tint/10 placeholder:text-muted-foreground/40 resize-none transition-colors"

/** Codex next-step actions shown in the unified commit/push modal. */
type NextStep = "commit" | "commit-and-push" | "push"

interface CommitDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootPath: string
  branch: string | null
  fileCount: number
  additions: number
  deletions: number
}

/**
 * Codex-style unified "Commit or push" modal.
 * One toolbar button opens this dialog; next steps are Commit / Commit and push / Push.
 */
export function CommitDialog({
  open,
  onOpenChange,
  rootPath,
  branch,
  fileCount,
  additions,
  deletions,
}: CommitDialogProps) {
  const intl = useIntl()
  const { run, running } = useGitWorkflow(rootPath)
  const [nextStep, setNextStep] = useState<NextStep>("commit")
  const [message, setMessage] = useState("")
  const [includeUnstaged, setIncludeUnstaged] = useState(true)
  const [force, setForce] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [noUpstream, setNoUpstream] = useState(false)
  const [ahead, setAhead] = useState(0)
  const [statusBranch, setStatusBranch] = useState<string | null>(branch)
  // Non-null once the user picks "New branch" — created right before the commit
  // so an abandoned dialog leaves the repo untouched.
  const [newBranch, setNewBranch] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMessage("")
    setIncludeUnstaged(true)
    setForce(false)
    setGenerating(false)
    setStatusBranch(branch)
    setNewBranch(null)
    void api
      .gitPushStatus(rootPath)
      .then((s) => {
        setNoUpstream(s.upstream == null)
        setAhead(s.ahead)
        if (s.branch) setStatusBranch(s.branch)
      })
      .catch(() => {})
  }, [open, rootPath, branch])

  // The working tree decides what is possible, not the review's current scope:
  // the diff can be showing a past commit while the tree is clean.
  const { data: gitStatus } = useGitStatus(rootPath)
  const uncommittedCount = gitStatus
    ? gitStatus.staged.length + gitStatus.unstaged.length + gitStatus.untracked.length
    : fileCount
  const branchingOff = newBranch != null && newBranch.trim().length > 0

  const canCommit = uncommittedCount > 0
  // A branch with no upstream always has something to push (itself), and a
  // freshly created one is by definition not on the remote yet.
  const canPush = ahead > 0 || noUpstream || branchingOff
  const nothingToDo = !canCommit && !canPush

  // Land on a step that can actually run — opening on a disabled "Commit" with
  // an empty tree was the old behaviour and it just failed on Continue.
  useEffect(() => {
    if (!open) return
    setNextStep(canCommit ? "commit" : canPush ? "push" : "commit")
  }, [open, canCommit, canPush])

  const busy = running || generating
  const needsCommit = nextStep === "commit" || nextStep === "commit-and-push"
  const needsPush = nextStep === "push" || nextStep === "commit-and-push"

  const handleContinue = async () => {
    let finalMessage = message.trim()

    if (needsCommit) {
      if (finalMessage.length === 0) {
        setGenerating(true)
        try {
          finalMessage = await api.gitGenerateCommitMessage(rootPath)
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : intl.formatMessage({
                  id: "commit.error.generate",
                  defaultMessage: "Failed to generate commit message",
                })
          )
          setGenerating(false)
          return
        }
        setGenerating(false)
        if (!finalMessage) {
          toast.error(
            intl.formatMessage({
              id: "commit.error.empty",
              defaultMessage: "Couldn't generate a commit message.",
            })
          )
          return
        }
      }
    }

    const targetBranch = newBranch?.trim()
    if (targetBranch) {
      try {
        await api.gitCheckoutNewBranch(rootPath, targetBranch)
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : intl.formatMessage({
                id: "commit.error.branch",
                defaultMessage: "Failed to create the branch",
              })
        )
        return
      }
      setStatusBranch(targetBranch)
      setNewBranch(null)
    }

    const steps =
      nextStep === "commit"
        ? (["commit"] as const)
        : nextStep === "push"
          ? (["push"] as const)
          : (["commit", "push"] as const)

    const ok = await run({
      steps: [...steps],
      commit: needsCommit
        ? { message: finalMessage, includeUnstaged }
        : undefined,
      // A branch created a moment ago has no upstream yet, whatever the status
      // said when the dialog opened.
      push: needsPush ? { setUpstream: noUpstream || !!targetBranch, force } : undefined,
      branch: targetBranch ?? statusBranch,
    })
    if (ok) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <div className="space-y-4 p-5 pb-4">
          <DialogHeader>
            <DialogTitle className="text-base">
              <FormattedMessage id="commit.title" defaultMessage="Commit or push" />
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  <FormattedMessage id="commit.branch" defaultMessage="Branch" />
                </span>
                <BranchTarget
                  currentBranch={statusBranch}
                  newBranch={newBranch}
                  onNewBranchChange={setNewBranch}
                  disabled={busy}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  <FormattedMessage id="commit.changes" defaultMessage="Changes" />
                </span>
                <span className="inline-flex items-center gap-2 font-mono tabular-nums text-xs">
                  <span className="text-muted-foreground">
                    <FormattedMessage
                      id="commit.fileCount"
                      defaultMessage="{count, plural, one {# file} other {# files}}"
                      values={{ count: uncommittedCount }}
                    />
                  </span>
                  {uncommittedCount > 0 && additions > 0 && (
                    <span className="text-[#3f9348] dark:text-[#77b985]">+{additions}</span>
                  )}
                  {uncommittedCount > 0 && deletions > 0 && (
                    <span className="text-[#c84d4d] dark:text-[#d17979]">-{deletions}</span>
                  )}
                </span>
              </div>
            </div>

            {needsCommit && (
              <>
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <span className="text-sm">
                    <FormattedMessage
                      id="commit.includeUnstaged"
                      defaultMessage="Include unstaged changes"
                    />
                  </span>
                  <Switch
                    checked={includeUnstaged}
                    onCheckedChange={setIncludeUnstaged}
                    disabled={busy}
                  />
                </label>

                <div className="space-y-1.5">
                  <label className="ml-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                    <FormattedMessage id="commit.message" defaultMessage="Commit message" />
                  </label>
                  <textarea
                    className={textareaCn}
                    rows={4}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder={intl.formatMessage({
                      id: "commit.messagePlaceholder",
                      defaultMessage: "Leave empty to auto-generate",
                    })}
                    spellCheck={false}
                    disabled={busy}
                  />
                </div>
              </>
            )}

            {needsPush && (
              <label className="flex cursor-pointer items-center justify-between gap-3">
                <span className="text-sm">
                  <FormattedMessage id="push.forcePush" defaultMessage="Force push" />{" "}
                  <span className="text-muted-foreground">(--force-with-lease)</span>
                </span>
                <Switch checked={force} onCheckedChange={setForce} disabled={busy} />
              </label>
            )}

            <div className="space-y-1.5">
              <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                <FormattedMessage id="push.nextSteps" defaultMessage="Next steps" />
              </span>
              <div className="overflow-hidden rounded-xl border border-border/40 bg-background/40">
                <StepRow
                  icon={<GitCommitHorizontal className="h-4 w-4" />}
                  label={intl.formatMessage({
                    id: "push.step.commit",
                    defaultMessage: "Commit",
                  })}
                  selected={nextStep === "commit"}
                  onSelect={() => setNextStep("commit")}
                  disabled={busy || !canCommit}
                />
                <div className="border-t border-border/40" />
                <StepRow
                  icon={<GitCommitHorizontal className="h-4 w-4" />}
                  label={intl.formatMessage({
                    id: "push.step.commitAndPush",
                    defaultMessage: "Commit and push",
                  })}
                  selected={nextStep === "commit-and-push"}
                  onSelect={() => setNextStep("commit-and-push")}
                  disabled={busy || !canCommit}
                />
                <div className="border-t border-border/40" />
                <StepRow
                  icon={<ArrowUp className="h-4 w-4" />}
                  label={intl.formatMessage({
                    id: "push.step.push",
                    defaultMessage: "Push",
                  })}
                  selected={nextStep === "push"}
                  onSelect={() => setNextStep("push")}
                  disabled={busy || !canPush}
                />
              </div>
              {nothingToDo && (
                <p className="ml-1 text-[11px] text-muted-foreground/80">
                  <FormattedMessage
                    id="commit.nothingToDo"
                    defaultMessage="Nothing to commit or push — the branch is clean and up to date."
                  />
                </p>
              )}
              {nextStep === "commit-and-push" && (
                <p className="ml-1 text-[11px] text-muted-foreground/80">
                  <FormattedMessage
                    id="push.commitAndPushHint"
                    defaultMessage="Stages all changes and auto-generates the commit message when empty."
                  />
                </p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="mx-0 mb-0 px-5">
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5"
            onClick={handleContinue}
            disabled={
              busy || nothingToDo || (newBranch != null && newBranch.trim().length === 0)
            }
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {generating
              ? intl.formatMessage({ id: "commit.generating", defaultMessage: "Generating…" })
              : running
                ? intl.formatMessage({ id: "push.working", defaultMessage: "Working…" })
                : intl.formatMessage({ id: "common.continue", defaultMessage: "Continue" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StepRow({
  icon,
  label,
  selected,
  onSelect,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  selected: boolean
  onSelect: () => void
  disabled: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-3 px-3 py-2.5 text-sm transition-colors disabled:pointer-events-none disabled:opacity-50",
        selected
          ? "bg-muted/50 text-foreground"
          : "text-muted-foreground hover:bg-muted/30 hover:text-foreground"
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {selected && <Check className="h-4 w-4 text-foreground" />}
    </button>
  )
}

/**
 * "Commit to" control: the current branch, or a name to branch off onto first.
 * Switching to an existing branch is deliberately not offered — that moves the
 * working tree around under a dialog the user opened to commit it.
 */
function BranchTarget({
  currentBranch,
  newBranch,
  onNewBranchChange,
  disabled,
}: {
  currentBranch: string | null
  newBranch: string | null
  onNewBranchChange: (name: string | null) => void
  disabled: boolean
}) {
  const intl = useIntl()

  if (newBranch != null) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          className="min-w-0 flex-1 rounded-lg border border-border/50 bg-background/60 px-2 py-1 text-xs focus:border-tint/40 focus:outline-none"
          value={newBranch}
          onChange={(e) => onNewBranchChange(e.target.value)}
          placeholder={intl.formatMessage({
            id: "commit.newBranchPlaceholder",
            defaultMessage: "new-branch-name",
          })}
          spellCheck={false}
          disabled={disabled}
          autoFocus
        />
        <button
          type="button"
          onClick={() => onNewBranchChange(null)}
          disabled={disabled}
          aria-label={intl.formatMessage({ id: "common.cancel", defaultMessage: "Cancel" })}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border/50 bg-background/60 px-2 text-xs font-medium transition-colors hover:bg-secondary-hover disabled:opacity-50"
        >
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          {currentBranch ?? "—"}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
          <FormattedMessage id="commit.commitTo" defaultMessage="Commit to" />
        </DropdownMenuLabel>
        <DropdownMenuItem className="gap-2" onSelect={() => onNewBranchChange(null)}>
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1 truncate">{currentBranch ?? "—"}</span>
          <Check className="h-4 w-4" />
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2" onSelect={() => onNewBranchChange("")}>
          <Plus className="h-4 w-4 text-muted-foreground" />
          <FormattedMessage id="commit.newBranch" defaultMessage="New branch" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
