import { useMemo, useState } from "react"
import { useIntl, FormattedMessage } from "react-intl"
import { ChevronDown, FileSearch, Folders, GitCommitHorizontal, ListCollapse, ListRestart, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
  rootPath: string
  baseBranch: string | null
  onBaseBranchChange: (branch: string) => void
  commitSha: string | null
  onCommitShaChange: (sha: string) => void
}

/**
 * Codex review header: full-width bar with
 * `grid-cols-[minmax(0,1fr)_auto]` semantics — left scope/stats, right action
 * chrome. Action chrome never leaves this bar (matches codex.review.header).
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
  rootPath,
  baseBranch,
  onBaseBranchChange,
  commitSha,
  onCommitShaChange,
}: ReviewToolbarProps) {
  const intl = useIntl()
  return (
    <div className="grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 border-b border-border/50 px-3 text-xs">
      <div className="flex min-w-0 items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-foreground hover:bg-muted/60"
          >
            <span>{intl.formatMessage(SCOPE_MESSAGES[scope])}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44 border-border/40">
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
      <DiffStats additions={totals.additions} deletions={totals.deletions} />
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
        />
    </div>
  )
}

/**
 * Codex-style single "Commit" button — opens the unified Commit-or-push dialog
 * where the user picks Commit / Commit and push / Push.
 */
export function CommitButton({ onCommit, className }: { onCommit: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onCommit}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-foreground hover:bg-muted/60",
        className,
      )}
    >
      <GitCommitHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
      <span>
        <FormattedMessage id="review.commit" defaultMessage="Commit" />
      </span>
    </button>
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
  className,
}: DiffToolbarControlsProps) {
  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <CommitButton onCommit={onCommit} className="mr-1" />
      <CollapseAllDiffsButton
        disabled={files.length === 0}
        areAllDiffsCollapsed={areAllDiffsCollapsed}
        onToggleAllDiffs={onToggleAllDiffs}
      />
      <FileJumpButton files={files} activePath={activePath} onSelectPath={onSelectPath} />
      <ViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
      <TreeToggle isTreeVisible={isTreeVisible} onToggleTree={onToggleTree} />
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
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
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
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <FileSearch className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 border-border/40 p-2">
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
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
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
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
        viewMode === "split"
          ? "bg-muted/60 text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
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
        <span className="relative bg-[#c84d4d]/20">
          <span className="absolute left-0 top-0 h-full w-0.5 bg-[#c84d4d]/75" />
        </span>
        <span className="relative border-t border-border/50 bg-[#3f9348]/20">
          <span className="absolute left-0 top-0 h-full w-0.5 bg-[#3f9348]/75" />
        </span>
      </span>
    )
  }

  return (
    <span
      aria-hidden="true"
      className="grid h-3.5 w-3.5 grid-cols-2 overflow-hidden rounded-[3px] border border-border/60 bg-background"
    >
      <span className="relative bg-[#c84d4d]/20">
        <span className="absolute left-0 top-0 h-full w-0.5 bg-[#c84d4d]/75" />
      </span>
      <span className="relative border-l border-border/50 bg-[#3f9348]/20">
        <span className="absolute left-0 top-0 h-full w-0.5 bg-[#3f9348]/75" />
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
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
        // Codex pattern: same `Folders` glyph in both states; the *button*
        // toggles between secondary (filled) when open and ghost
        // (hover-only) when closed.
        isTreeVisible
          ? "bg-muted/60 text-foreground hover:bg-muted/80"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Folders className="h-3.5 w-3.5" />
    </button>
  )
}

