import { useMemo, useState } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { useQuery } from "@tanstack/react-query"
import { Check, ChevronDown, ChevronUp, GitBranch, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TOOLBAR_PILL, TOOLBAR_PILL_BUTTON } from "@/components/ui/toolbar-styles"

/**
 * "↑ 3 changes ↓" — steps through the changed blocks of the previewed file.
 * Reads "2 of 3" once a block has been stepped to.
 */
export function ChangeNavigator({
  count,
  activeIndex,
  onNavigate,
}: {
  count: number
  /** Block last stepped to, -1 before any. */
  activeIndex: number
  onNavigate: (index: number) => void
}) {
  const intl = useIntl()
  return (
    <div
      role="group"
      aria-label={intl.formatMessage({ id: "filePreview.diff.navigateChanges", defaultMessage: "Navigate changes" })}
      className={TOOLBAR_PILL}
    >
      <button
        type="button"
        disabled={activeIndex <= 0}
        onClick={() => onNavigate(activeIndex - 1)}
        aria-label={intl.formatMessage({ id: "filePreview.diff.previousChange", defaultMessage: "Previous change" })}
        title={intl.formatMessage({ id: "filePreview.diff.previousChange", defaultMessage: "Previous change" })}
        className={cn(TOOLBAR_PILL_BUTTON, "w-8")}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <span role="status" className="px-1 tabular-nums text-muted-foreground">
        {activeIndex < 0 ? (
          <FormattedMessage
            id="filePreview.diff.changeCount"
            defaultMessage="{count, plural, one {# change} other {# changes}}"
            values={{ count }}
          />
        ) : (
          <FormattedMessage
            id="filePreview.diff.changePosition"
            defaultMessage="{position} of {count}"
            values={{ position: activeIndex + 1, count }}
          />
        )}
      </span>
      <button
        type="button"
        disabled={activeIndex >= count - 1}
        onClick={() => onNavigate(activeIndex + 1)}
        aria-label={intl.formatMessage({ id: "filePreview.diff.nextChange", defaultMessage: "Next change" })}
        title={intl.formatMessage({ id: "filePreview.diff.nextChange", defaultMessage: "Next change" })}
        className={cn(TOOLBAR_PILL_BUTTON, "w-8")}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/**
 * "origin/main ▾" — what the preview compares against. The list is `HEAD`
 * (uncommitted changes) plus every branch. There's no way to switch the
 * comparison off: a file with no changes against the base just reads plain.
 */
export function DiffBasePill({
  rootPath,
  base,
  onBaseChange,
}: {
  rootPath: string
  base: string
  onBaseChange: (base: string) => void
}) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const branchQuery = useQuery({
    queryKey: ["git", rootPath, "branches"],
    queryFn: () => api.gitBranches(rootPath),
    enabled: open,
    staleTime: 30_000,
  })
  const names = useMemo(
    () => ["HEAD", ...(branchQuery.data ?? []).map((b) => b.name)],
    [branchQuery.data]
  )
  const normalizedQuery = query.trim().toLowerCase()
  const visible = normalizedQuery.length === 0
    ? names
    : names.filter((name) => name.toLowerCase().includes(normalizedQuery))

  return (
    <div className={cn(TOOLBAR_PILL, "max-w-44")}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery("")
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            title={intl.formatMessage({ id: "filePreview.diff.compareWith", defaultMessage: "Compare with" })}
            className={cn(TOOLBAR_PILL_BUTTON, "min-w-0 shrink gap-1 pl-3 pr-2.5 text-foreground")}
          >
            <span className="min-w-0 truncate">{base}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent onCloseAutoFocus={(e) => e.preventDefault()} align="start" className="w-72 border-border/40 p-2">
          <div className="flex h-8 items-center gap-2 rounded-lg border border-border/40 bg-muted/20 px-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={intl.formatMessage({ id: "review.searchBranches", defaultMessage: "Search branches" })}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <div className="mt-1 max-h-72 overflow-auto py-1">
            {visible.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => {
                  onBaseChange(name)
                  setOpen(false)
                  setQuery("")
                }}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-row-hover",
                  name === base && "bg-row-selected"
                )}
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
                {name === "HEAD" && (
                  <span className="shrink-0 text-muted-foreground">
                    <FormattedMessage id="filePreview.diff.uncommitted" defaultMessage="Uncommitted" />
                  </span>
                )}
                {name === base && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
              </button>
            ))}
            {branchQuery.isLoading && (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                <FormattedMessage id="common.loading" defaultMessage="Loading…" />
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
