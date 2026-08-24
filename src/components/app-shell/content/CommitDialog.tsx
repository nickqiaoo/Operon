import { useEffect, useState } from "react"
import { useIntl, FormattedMessage } from "react-intl"
import { ArrowUp, Check, GitBranch, GitCommitHorizontal, Loader2 } from "lucide-react"
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
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { useGitWorkflow } from "./use-git-workflow"

const textareaCn =
  "w-full px-3 py-2 text-sm bg-background/50 rounded-xl border border-transparent hover:bg-background/70 focus:bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40 resize-none transition-colors"

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
  const [statusBranch, setStatusBranch] = useState<string | null>(branch)

  useEffect(() => {
    if (!open) return
    setNextStep("commit")
    setMessage("")
    setIncludeUnstaged(true)
    setForce(false)
    setGenerating(false)
    setStatusBranch(branch)
    void api
      .gitPushStatus(rootPath)
      .then((s) => {
        setNoUpstream(s.upstream == null)
        if (s.branch) setStatusBranch(s.branch)
      })
      .catch(() => {})
  }, [open, rootPath, branch])

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
      push: needsPush ? { setUpstream: noUpstream, force } : undefined,
      branch: statusBranch,
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
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  <FormattedMessage id="commit.branch" defaultMessage="Branch" />
                </span>
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                  {statusBranch ?? "—"}
                </span>
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
                      values={{ count: fileCount }}
                    />
                  </span>
                  {additions > 0 && (
                    <span className="text-[#3f9348] dark:text-[#77b985]">+{additions}</span>
                  )}
                  {deletions > 0 && (
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
                  disabled={busy}
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
                  disabled={busy}
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
                  disabled={busy}
                />
              </div>
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

        <DialogFooter className="border-t border-border/40 px-5 py-3 sm:justify-end">
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
            disabled={busy}
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
