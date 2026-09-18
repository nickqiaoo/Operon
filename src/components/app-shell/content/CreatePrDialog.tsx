import { useEffect, useMemo, useState } from "react"
import { useIntl, FormattedMessage } from "react-intl"
import { ArrowUpRight, GitPullRequest, GitPullRequestDraft } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import type { PrRepoStatus } from "@/lib/git-queries"
import type { PrAction, StartPrInput } from "./use-pr-creation"

const fieldCn =
  "w-full bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none"

interface CreatePrDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: PrRepoStatus
  fileCount: number
  onStart: (input: StartPrInput) => void
}

/**
 * Codex-style Create-PR modal: `head → base` for context, a title and body that
 * auto-generate when left empty, one toggle for the working tree, and the three
 * ways to finish. Picking an action closes the dialog immediately — the work
 * continues on the toolbar button, which is also where it can be stopped.
 *
 * Branch names are not editable here: the toolbar only offers this on a
 * non-default branch, and the commit modal is where branches are made.
 */
export function CreatePrDialog({
  open,
  onOpenChange,
  status,
  fileCount,
  onStart,
}: CreatePrDialogProps) {
  const intl = useIntl()
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [commitLocalChanges, setCommitLocalChanges] = useState(true)

  const branch = status.currentBranch ?? ""
  const base = status.defaultBranch ?? "main"
  const hasLocalChanges = fileCount > 0
  // Every action here goes through `gh`, including the browser hand-off, which
  // still has to push the branch first. The toolbar already refuses to open
  // this dialog without it; these are for a status that changed since.
  const canUseApi = status.canCreatePr
  const needsGhHint = status.ghInstalled
    ? intl.formatMessage({
        id: "review.pr.authGh",
        defaultMessage: "Authenticate GitHub CLI: run `gh auth login`",
      })
    : intl.formatMessage({
        id: "review.pr.installGh",
        defaultMessage: "Install GitHub CLI (gh) to create PRs",
      })

  const actions = useMemo(
    () => [
      {
        id: "pr" as const,
        label: intl.formatMessage({ id: "pr.action.create", defaultMessage: "Create Pull Request" }),
        icon: <GitPullRequest className="h-4 w-4" />,
        disabled: !canUseApi,
      },
      {
        id: "draft" as const,
        label: intl.formatMessage({ id: "pr.action.draft", defaultMessage: "Create draft PR" }),
        icon: <GitPullRequestDraft className="h-4 w-4" />,
        disabled: !canUseApi,
      },
      {
        id: "browser" as const,
        label: intl.formatMessage({ id: "pr.action.browser", defaultMessage: "Open PR in browser" }),
        icon: <ArrowUpRight className="h-4 w-4" />,
        // Not a credential-free path: it pushes the branch before handing the
        // compare page over.
        disabled: !canUseApi,
      },
    ],
    [intl, canUseApi],
  )

  // ⌘↵ runs whatever is highlighted, so the highlight starts on the first row
  // that is actually available rather than on a disabled one.
  const firstEnabled = Math.max(
    actions.findIndex((a) => !a.disabled),
    0,
  )
  const [selected, setSelected] = useState(firstEnabled)

  useEffect(() => {
    if (!open) return
    setTitle("")
    setBody("")
    setCommitLocalChanges(true)
    setSelected(firstEnabled)
  }, [open, firstEnabled])

  const start = (action: PrAction) => {
    if (!canUseApi) return
    onStart({ action, branch, base, title, body, commitLocalChanges })
    onOpenChange(false)
  }

  /** Move the highlight, skipping rows that cannot run. */
  const moveSelection = (delta: number) => {
    const count = actions.length
    for (let step = 1; step <= count; step++) {
      const next = (selected + delta * step + count * count) % count
      if (!actions[next].disabled) {
        setSelected(next)
        return
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-md"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            start(actions[selected].id)
            return
          }
          // Arrow keys belong to the caret while the caret is in a field —
          // stealing them there would break editing the description.
          const inField =
            e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
          if (inField || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return
          e.preventDefault()
          moveSelection(e.key === "ArrowDown" ? 1 : -1)
        }}
      >
        <div className="space-y-4 p-5 pb-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <span className="truncate font-mono text-foreground">{branch || "—"}</span>
              <span aria-hidden="true">→</span>
              <span className="truncate font-mono">{base}</span>
            </DialogTitle>
          </DialogHeader>

          <div className="overflow-hidden rounded-xl border border-border/50 bg-background/40">
            <input
              className={fieldCn}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={intl.formatMessage({
                id: "pr.titlePlaceholder",
                defaultMessage: "Title (auto-generated if left empty)",
              })}
              spellCheck={false}
              autoFocus
            />
            <div className="border-t border-border/40" />
            <textarea
              className={cn(fieldCn, "resize-none")}
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={intl.formatMessage({
                id: "pr.bodyPlaceholder",
                defaultMessage: "Description (auto-generated if left empty)",
              })}
              spellCheck={false}
            />
          </div>

          {hasLocalChanges && (
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span className="text-sm">
                <FormattedMessage
                  id="pr.commitLocalChanges"
                  defaultMessage="Commit and push local changes"
                />{" "}
                <span className="text-muted-foreground">
                  <FormattedMessage
                    id="pr.fileCount"
                    defaultMessage="({count, plural, one {# file} other {# files}})"
                    values={{ count: fileCount }}
                  />
                </span>
              </span>
              <Switch checked={commitLocalChanges} onCheckedChange={setCommitLocalChanges} />
            </label>
          )}
        </div>

        <div className="border-t border-border/40">
          {actions.map((action, index) => (
            <div key={action.id}>
              {index > 0 && <div className="border-t border-border/40" />}
              <ActionRow
                icon={action.icon}
                label={action.label}
                hint={action.disabled ? needsGhHint : undefined}
                disabled={action.disabled}
                selected={index === selected}
                onHover={() => !action.disabled && setSelected(index)}
                onSelect={() => start(action.id)}
              />
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ActionRow({
  icon,
  label,
  hint,
  disabled,
  selected,
  onHover,
  onSelect,
}: {
  icon: React.ReactNode
  label: string
  hint?: string
  disabled: boolean
  selected: boolean
  onHover: () => void
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={onHover}
      onFocus={onHover}
      disabled={disabled}
      title={hint}
      className={cn(
        "flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm transition-colors",
        "text-foreground disabled:pointer-events-none disabled:opacity-50",
        selected && "bg-secondary-hover",
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
      {selected && (
        <kbd className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          ⌘↵
        </kbd>
      )}
    </button>
  )
}
