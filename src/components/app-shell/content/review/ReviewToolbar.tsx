import { useMemo, useState } from "react"
import { useIntl, FormattedMessage } from "react-intl"
import {
  ArrowUpFromLine,
  ChevronDown,
  FileSearch,
  Folders,
  GitPullRequest,
  ListCollapse,
  ListRestart,
  Loader2,
  Search,
  Square,
} from "lucide-react"
import { openExternalUrl } from "@/lib/open-external"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  TOOLBAR_ICON_BUTTON,
  TOOLBAR_ICON_BUTTON_ON,
  TOOLBAR_PILL,
  TOOLBAR_PILL_BUTTON,
} from "@/components/ui/toolbar-styles"
import type { ExistingPr, PrPhase } from "../use-pr-creation"
import type { BranchInfo, DiffScope, FileChange } from "./types"
import { SCOPE_MESSAGES } from "./constants"
import { DiffStats } from "./DiffStats"
import { BranchPicker, CommitPicker } from "./ReviewPickers"

export interface ReviewToolbarProps {
  scope: DiffScope
  onScopeChange: (scope: DiffScope) => void
  /** Show the "Last turn" scope option (only when a chat turn is targeted). */
  showLastTurn?: boolean
  branch: BranchInfo | null
  totals: {
    additions: number
    deletions: number
    changedBytes: number
    changedLines: number
  }
  files: FileChange[]
  activePath: string | null
  onSelectPath: (path: string | null) => void
  viewMode: "unified" | "split"
  onViewModeChange: (mode: "unified" | "split") => void
  isTreeVisible: boolean
  onToggleTree: () => void
  areAllDiffsCollapsed: boolean
  onToggleAllDiffs: () => void
  onCommit: () => void
  onCreatePr: () => void
  /** Null when a PR cannot be opened from here; the string says why. */
  prBlockedReason: string | null
  /** Null when there is something to commit or push; the string says why not. */
  commitBlockedReason: string | null
  primaryAction: "commit" | "pr"
  existingPr: ExistingPr | null
  prPhase: PrPhase | null
  onStopPr: () => void
  rootPath: string
  baseBranch: string | null
  onBaseBranchChange: (branch: string) => void
  commitSha: string | null
  onCommitShaChange: (sha: string) => void
}

/**
 * Codex review header: full-width row with
 * `grid-cols-[minmax(0,1fr)_auto]` semantics — left scope/stats, right action
 * chrome. Action chrome never leaves this row (matches codex.review.header).
 * Built from the same capsules as the file browser's toolbar, so the two
 * sibling tabs share one row height and one button look.
 */
export function ReviewToolbar({
  scope,
  onScopeChange,
  showLastTurn,
  branch,
  totals,
  files,
  activePath,
  onSelectPath,
  viewMode,
  onViewModeChange,
  isTreeVisible,
  onToggleTree,
  areAllDiffsCollapsed,
  onToggleAllDiffs,
  onCommit,
  onCreatePr,
  prBlockedReason,
  commitBlockedReason,
  primaryAction,
  existingPr,
  prPhase,
  onStopPr,
  rootPath,
  baseBranch,
  onBaseBranchChange,
  commitSha,
  onCommitShaChange,
}: ReviewToolbarProps) {
  const intl = useIntl()
  return (
    <div className="grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 px-2 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              TOOLBAR_PILL,
              "gap-1 pl-3 pr-2.5 font-medium text-foreground transition-colors hover:bg-accent-hover data-[state=open]:bg-accent-active"
            )}
          >
            <span>{intl.formatMessage(SCOPE_MESSAGES[scope])}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
          <DropdownMenuContent onCloseAutoFocus={(e) => e.preventDefault()} align="start" className="w-44 border-border/40">
          <DropdownMenuRadioGroup
            value={scope}
            onValueChange={(v) => onScopeChange(v as DiffScope)}
          >
            {(showLastTurn || scope === "lastTurn") && (
                <DropdownMenuRadioItem value="lastTurn">
                  {intl.formatMessage(SCOPE_MESSAGES.lastTurn)}
                </DropdownMenuRadioItem>
            )}
              <DropdownMenuRadioItem value="unstaged">
                {intl.formatMessage(SCOPE_MESSAGES.unstaged)}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="staged">
                {intl.formatMessage(SCOPE_MESSAGES.staged)}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="commit">
                {intl.formatMessage(SCOPE_MESSAGES.commit)}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="branch">
                {intl.formatMessage(SCOPE_MESSAGES.branch)}
              </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="px-1">
        <DiffStats additions={totals.additions} deletions={totals.deletions} />
      </span>
      {scope === "branch" && (
        <BranchPicker
          rootPath={rootPath}
          head={branch?.current ?? null}
          base={baseBranch}
          onBaseChange={onBaseBranchChange}
        />
      )}
      {scope === "commit" && (
          <CommitPicker rootPath={rootPath} selectedSha={commitSha} onSelect={onCommitShaChange} />
      )}
      </div>
        <DiffToolbarControls
          files={files}
          activePath={activePath}
          onSelectPath={onSelectPath}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          isTreeVisible={isTreeVisible}
          onToggleTree={onToggleTree}
          areAllDiffsCollapsed={areAllDiffsCollapsed}
          onToggleAllDiffs={onToggleAllDiffs}
          onCommit={onCommit}
          onCreatePr={onCreatePr}
          prBlockedReason={prBlockedReason}
          commitBlockedReason={commitBlockedReason}
          primaryAction={primaryAction}
          existingPr={existingPr}
          prPhase={prPhase}
          onStopPr={onStopPr}
        />
    </div>
  )
}

/**
 * Codex-style split button. The body runs whichever action the repo is
 * actually waiting for — "Commit or push" while anything is uncommitted or
 * unpushed, "Create PR" once the branch is clean and publishable — and the
 * caret always offers both. While a PR is being created the whole button turns
 * into a progress/stop control, because the dialog is already gone by then.
 *
 * PR creation needs a branch other than the base, so on the default branch the
 * menu item stays visible but disabled, pointing at the commit modal where a
 * branch can be made.
 */
export function CommitSplitButton({
  onCommit,
  onCreatePr,
  prBlockedReason,
  commitBlockedReason,
  primaryAction,
  existingPr,
  prPhase,
  onStopPr,
  className,
}: {
  onCommit: () => void
  onCreatePr: () => void
  prBlockedReason: string | null
  commitBlockedReason: string | null
  primaryAction: "commit" | "pr"
  /** The open PR for this branch, when there already is one. */
  existingPr: ExistingPr | null
  /** Non-null while a PR run is in flight; only "summary" can be stopped. */
  prPhase: PrPhase | null
  onStopPr: () => void
  className?: string
}) {
  const intl = useIntl()
  const commitLabel = intl.formatMessage({
    id: "review.commitOrPush",
    defaultMessage: "Commit or push",
  })
  const prLabel = intl.formatMessage({ id: "review.createPr", defaultMessage: "Create Pull Request" })
  // An existing PR is its own reason, and it outranks the rest: the branch is
  // already published, so none of the earlier checks are what stops you.
  const createPrDisabledReason =
    existingPr != null
      ? intl.formatMessage({
          id: "review.pr.exists",
          defaultMessage: "A pull request already exists for this branch",
        })
      : prBlockedReason

  const shellCn = cn(TOOLBAR_PILL, className)

  if (prPhase != null) {
    const canStop = prPhase === "summary"
    return (
      <div className={shellCn}>
        <button
          type="button"
          onClick={canStop ? onStopPr : undefined}
          disabled={!canStop}
          title={
            canStop
              ? intl.formatMessage({ id: "review.pr.stop", defaultMessage: "Stop" })
              : undefined
          }
          className={cn(TOOLBAR_PILL_BUTTON, "gap-1.5 px-3 font-medium")}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          <span>
            {prPhase === "summary" ? (
              <FormattedMessage id="review.pr.generating" defaultMessage="Writing summary…" />
            ) : (
              <FormattedMessage id="review.pr.publishing" defaultMessage="Creating PR…" />
            )}
          </span>
          {canStop && <Square className="h-3 w-3 fill-current" />}
        </button>
      </div>
    )
  }

  // An existing PR outranks "create": creating a second one for the same branch
  // is not a thing GitHub allows.
  const primaryIsPr = primaryAction === "pr" || existingPr != null
  const showsExisting = existingPr != null && primaryAction === "pr"

  return (
    <div className={shellCn}>
      <button
        type="button"
        onClick={
          showsExisting ? () => openExternalUrl(existingPr.url) : primaryIsPr ? onCreatePr : onCommit
        }
        disabled={!primaryIsPr && commitBlockedReason != null}
        title={showsExisting ? existingPr.title : (commitBlockedReason ?? undefined)}
        className={cn(TOOLBAR_PILL_BUTTON, "gap-1.5 pl-3 pr-2 font-medium text-foreground")}
      >
        {primaryIsPr ? (
          <GitPullRequest className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ArrowUpFromLine className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span>
          {showsExisting ? (
            <FormattedMessage
              id="review.pr.view"
              defaultMessage="View PR #{number}"
              values={{ number: existingPr.number }}
            />
          ) : primaryIsPr ? (
            prLabel
          ) : (
            commitLabel
          )}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={intl.formatMessage({
              id: "review.moreGitActions",
              defaultMessage: "More git actions",
            })}
            className={cn(
              TOOLBAR_PILL_BUTTON,
              "w-7 pr-0.5 data-[state=open]:bg-accent-active data-[state=open]:text-foreground"
            )}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent onCloseAutoFocus={(e) => e.preventDefault()} align="end" className="min-w-52">
          <DropdownMenuItem
            onSelect={onCommit}
            disabled={commitBlockedReason != null}
            className="gap-2"
          >
            <ArrowUpFromLine className="h-4 w-4 text-muted-foreground" />
            <span className="flex flex-col">
              {commitLabel}
              {commitBlockedReason != null && (
                <span className="text-[11px] text-muted-foreground">{commitBlockedReason}</span>
              )}
            </span>
          </DropdownMenuItem>
          {existingPr != null && (
            <DropdownMenuItem
              onSelect={() => openExternalUrl(existingPr.url)}
              className="gap-2"
            >
              <GitPullRequest className="h-4 w-4 text-muted-foreground" />
              <FormattedMessage
                id="review.pr.view"
                defaultMessage="View PR #{number}"
                values={{ number: existingPr.number }}
              />
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={onCreatePr}
            disabled={prBlockedReason != null || existingPr != null}
            className="gap-2"
          >
            <GitPullRequest className="h-4 w-4 text-muted-foreground" />
            <span className="flex flex-col">
              {prLabel}
              {createPrDisabledReason != null && (
                <span className="text-[11px] text-muted-foreground">{createPrDisabledReason}</span>
              )}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export interface DiffToolbarControlsProps {
  files: FileChange[]
  activePath: string | null
  onSelectPath: (path: string | null) => void
  viewMode: "unified" | "split"
  onViewModeChange: (mode: "unified" | "split") => void
  isTreeVisible: boolean
  onToggleTree: () => void
  areAllDiffsCollapsed: boolean
  onToggleAllDiffs: () => void
  onCommit: () => void
  onCreatePr: () => void
  prBlockedReason: string | null
  commitBlockedReason: string | null
  primaryAction: "commit" | "pr"
  existingPr: ExistingPr | null
  prPhase: PrPhase | null
  onStopPr: () => void
  className?: string
}

export function DiffToolbarControls({
  files,
  activePath,
  onSelectPath,
  viewMode,
  onViewModeChange,
  isTreeVisible,
  onToggleTree,
  areAllDiffsCollapsed,
  onToggleAllDiffs,
  onCommit,
  onCreatePr,
  prBlockedReason,
  commitBlockedReason,
  primaryAction,
  existingPr,
  prPhase,
  onStopPr,
  className,
}: DiffToolbarControlsProps) {
  return (
    // Same order as the file browser's toolbar: icon buttons, then the split
    // capsule at the far right where "Open ▾" sits on the Files tab.
    <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <FileJumpButton files={files} activePath={activePath} onSelectPath={onSelectPath} />
      <CollapseAllDiffsButton
        disabled={files.length === 0}
        areAllDiffsCollapsed={areAllDiffsCollapsed}
        onToggleAllDiffs={onToggleAllDiffs}
      />
      <ViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
      <TreeToggle isTreeVisible={isTreeVisible} onToggleTree={onToggleTree} />
      <CommitSplitButton
        onCommit={onCommit}
        onCreatePr={onCreatePr}
        prBlockedReason={prBlockedReason}
        commitBlockedReason={commitBlockedReason}
        primaryAction={primaryAction}
        existingPr={existingPr}
        prPhase={prPhase}
        onStopPr={onStopPr}
        className="ml-1"
      />
    </div>
  )
}

/** Codex-style direct collapse/expand control — no overflow "…" menu. */
export function CollapseAllDiffsButton({
  disabled,
  areAllDiffsCollapsed,
  onToggleAllDiffs,
}: {
  disabled: boolean
  areAllDiffsCollapsed: boolean
  onToggleAllDiffs: () => void
}) {
  const intl = useIntl()
  const actionLabel = areAllDiffsCollapsed
    ? intl.formatMessage({
        id: "review.expandAllDiffs",
        defaultMessage: "Expand all diffs",
      })
    : intl.formatMessage({
        id: "review.collapseAllDiffs",
        defaultMessage: "Collapse all diffs",
      })
  const ActionIcon = areAllDiffsCollapsed ? ListRestart : ListCollapse

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={actionLabel}
      title={actionLabel}
      onClick={onToggleAllDiffs}
      className={TOOLBAR_ICON_BUTTON}
    >
      <ActionIcon className="h-3.5 w-3.5" />
    </button>
  )
}

export function FileJumpButton({
  files,
  activePath,
  onSelectPath,
}: {
  files: FileChange[]
  activePath: string | null
  onSelectPath: (path: string | null) => void
}) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const normalizedQuery = query.trim().toLowerCase()
  const jumpToFile = intl.formatMessage({
    id: "review.jumpToFile",
    defaultMessage: "Jump to file",
  })

  const visibleFiles = useMemo(() => {
    if (normalizedQuery.length === 0) return files
    return files.filter((file) => file.path.toLowerCase().includes(normalizedQuery))
  }, [files, normalizedQuery])

  const selectPath = (path: string) => {
    onSelectPath(path)
    setOpen(false)
    setQuery("")
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={files.length === 0}
          aria-label={jumpToFile}
          title={jumpToFile}
          className={TOOLBAR_ICON_BUTTON}
        >
          <FileSearch className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent onCloseAutoFocus={(e) => e.preventDefault()} align="end" className="w-72 border-border/40 p-2">
        <div className="flex h-8 items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={jumpToFile}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
          />
        </div>
        <div className="mt-1 max-h-72 overflow-auto py-1">
          {visibleFiles.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              <FormattedMessage id="review.noFilesFound" defaultMessage="No files found." />
            </div>
          ) : (
            visibleFiles.map((file) => {
              const segments = file.path.split("/")
              const name = segments.at(-1) ?? file.path
              const directory = segments.slice(0, -1).join("/")
              const active = file.path === activePath

              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => selectPath(file.path)}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-row-hover",
                    active && "bg-muted/70",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
                  {directory.length > 0 && (
                    <span className="max-w-32 truncate text-muted-foreground">{directory}</span>
                  )}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function ViewModeToggle({
  viewMode,
  onViewModeChange,
}: {
  viewMode: "unified" | "split"
  onViewModeChange: (mode: "unified" | "split") => void
}) {
  const intl = useIntl()
  const nextViewMode = viewMode === "unified" ? "split" : "unified"
  const label =
    nextViewMode === "split"
      ? intl.formatMessage({
          id: "review.switchToSplit",
          defaultMessage: "Switch to split diff view",
        })
      : intl.formatMessage({
          id: "review.switchToUnified",
          defaultMessage: "Switch to unified diff view",
        })

  return (
    <button
      type="button"
      onClick={() => onViewModeChange(nextViewMode)}
      aria-label={label}
      aria-pressed={viewMode === "split"}
      title={label}
      className={cn(TOOLBAR_ICON_BUTTON, viewMode === "split" && TOOLBAR_ICON_BUTTON_ON)}
    >
      <DiffLayoutIcon targetMode={nextViewMode} />
    </button>
  )
}

export function DiffLayoutIcon({ targetMode }: { targetMode: "unified" | "split" }) {
  if (targetMode === "unified") {
    return (
      <span
        aria-hidden="true"
        className="grid h-3.5 w-3.5 grid-rows-2 overflow-hidden rounded-[3px] border border-border/60 bg-background"
      >
        <span className="relative bg-diff-remove/20">
          <span className="absolute left-0 top-0 h-full w-0.5 bg-diff-remove/75" />
        </span>
        <span className="relative border-t border-border/50 bg-diff-add/20">
          <span className="absolute left-0 top-0 h-full w-0.5 bg-diff-add/75" />
        </span>
      </span>
    )
  }

  return (
    <span
      aria-hidden="true"
      className="grid h-3.5 w-3.5 grid-cols-2 overflow-hidden rounded-[3px] border border-border/60 bg-background"
    >
      <span className="relative bg-diff-remove/20">
        <span className="absolute left-0 top-0 h-full w-0.5 bg-diff-remove/75" />
      </span>
      <span className="relative border-l border-border/50 bg-diff-add/20">
        <span className="absolute left-0 top-0 h-full w-0.5 bg-diff-add/75" />
      </span>
    </span>
  )
}

export function TreeToggle({
  isTreeVisible,
  onToggleTree,
}: {
  isTreeVisible: boolean
  onToggleTree: () => void
}) {
  const intl = useIntl()
  const treeLabel = isTreeVisible
    ? intl.formatMessage({
        id: "review.hideFileTree",
        defaultMessage: "Hide file tree",
      })
    : intl.formatMessage({
        id: "review.showFileTree",
        defaultMessage: "Show file tree",
      })
  return (
    <button
      type="button"
      onClick={onToggleTree}
      aria-label={treeLabel}
      aria-pressed={isTreeVisible}
      title={treeLabel}
      // Codex pattern: same `Folders` glyph in both states; the button is
      // filled while the tree is open and ghost (hover-only) while closed.
      className={cn(TOOLBAR_ICON_BUTTON, isTreeVisible && TOOLBAR_ICON_BUTTON_ON)}
    >
      <Folders className="h-3.5 w-3.5" />
    </button>
  )
}

