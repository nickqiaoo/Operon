import { useMemo, useState } from "react"
import { useIntl, FormattedMessage } from "react-intl"
import { useQuery } from "@tanstack/react-query"
import { Check, ChevronDown, GitBranch, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export function BranchPicker({
  rootPath,
  head,
  base,
  onBaseChange,
}: {
  rootPath: string
  head: string | null
  base: string | null
  onBaseChange: (branch: string) => void
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
  const branches = branchQuery.data ?? []
  const normalizedQuery = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      normalizedQuery.length === 0
        ? branches
        : branches.filter((b) => b.name.toLowerCase().includes(normalizedQuery)),
    [branches, normalizedQuery],
  )

  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span className="text-foreground">{head ?? "—"}</span>
      <span className="text-muted-foreground/60">→</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-muted/60 hover:text-foreground"
          >
            <span>
              {base ??
                intl.formatMessage({
                  id: "review.selectBase",
                  defaultMessage: "Select base…",
                })}
            </span>
            <ChevronDown className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 border-border/40 p-2">
          <div className="flex h-8 items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={intl.formatMessage({
                id: "review.searchBranches",
                defaultMessage: "Search branches",
              })}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <div className="mt-1 max-h-72 overflow-auto py-1">
            {branchQuery.isLoading ? (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                <FormattedMessage id="common.loading" defaultMessage="Loading…" />
              </div>
            ) : visible.length === 0 ? (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                <FormattedMessage id="review.noBranchesFound" defaultMessage="No branches found." />
              </div>
            ) : (
              visible.map((b) => (
                <button
                  key={b.name}
                  type="button"
                  onClick={() => {
                    onBaseChange(b.name)
                    setOpen(false)
                    setQuery("")
                  }}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
                    b.name === base && "bg-muted/70",
                  )}
                >
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{b.name}</span>
                  {b.name === base && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </span>
  )
}

/**
 * Commit-scope selector: a searchable dropdown of recent commits. Picking one
 * shows that commit's diff (parent → commit).
 */
export function CommitPicker({
  rootPath,
  selectedSha,
  onSelect,
}: {
  rootPath: string
  selectedSha: string | null
  onSelect: (sha: string) => void
}) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const commitsQuery = useQuery({
    queryKey: ["git", rootPath, "commits"],
    queryFn: () => api.gitCommits(rootPath, 100),
    enabled: open || selectedSha != null,
    staleTime: 30_000,
  })
  const commits = commitsQuery.data ?? []
  const selected = commits.find((c) => c.sha === selectedSha)
  const normalizedQuery = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      normalizedQuery.length === 0
        ? commits
        : commits.filter(
            (c) =>
              c.subject.toLowerCase().includes(normalizedQuery) ||
              c.shortSha.toLowerCase().includes(normalizedQuery),
          ),
    [commits, normalizedQuery],
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <span className="max-w-65 truncate text-foreground">
            {selected
              ? selected.subject
              : selectedSha
                ? selectedSha.slice(0, 7)
                : intl.formatMessage({
                    id: "review.selectCommit",
                    defaultMessage: "Select commit…",
                  })}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 border-border/40 p-2">
        <div className="flex h-8 items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={intl.formatMessage({
              id: "review.searchCommits",
              defaultMessage: "Search commits",
            })}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
          />
        </div>
        <div className="mt-1 max-h-80 overflow-auto py-1">
          {commitsQuery.isLoading ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              <FormattedMessage id="common.loading" defaultMessage="Loading…" />
            </div>
          ) : visible.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              <FormattedMessage id="review.noCommitsFound" defaultMessage="No commits found." />
            </div>
          ) : (
            visible.map((c) => (
              <button
                key={c.sha}
                type="button"
                onClick={() => {
                  onSelect(c.sha)
                  setOpen(false)
                  setQuery("")
                }}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
                  c.sha === selectedSha && "bg-muted/70",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-foreground">{c.subject}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {c.shortSha}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground/70">
                  {c.relativeTime}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------

