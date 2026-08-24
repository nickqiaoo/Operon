import { useCallback, useEffect, useMemo, useState } from "react"
import { useIntl } from "react-intl"
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  FolderGit2,
  Globe,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react"
import type { InstalledSkill, SkillDetail, SkillInfo, SkillScope } from "@/types/skill"
import { api } from "@/lib/api"
import { useProjectStore } from "@/stores/project-store"
import { AgentBadges, AgentChips } from "./AgentBadges"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

const DEFAULT_SOURCE = "vercel-labs/agent-skills"

interface SkillPageProps {
  onBack: () => void
}

/** A skill as shown in the list — installed, available, or both. */
interface SkillListItem {
  name: string
  description: string
  installed: boolean
  /** Installed location, shown on the detail screen. */
  path?: string
  /** `owner/repo` it was installed from, when Operon has a record of it. */
  source?: string
  updatedAt?: string
  /** Agents that can see this skill. */
  agents?: string[]
  /** A project skill of the same name wins over this global one. */
  shadowed?: boolean
}

export function SkillPage({ onBack }: SkillPageProps) {
  const intl = useIntl()
  // Project scope targets the repository root, not the active worktree: a skill is a
  // property of the project, not of whichever branch happens to be checked out, and
  // the repo root is what can be committed and shared with the team.
  const projectPath = useProjectStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.rootPath)
  const projectName = useProjectStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.name)

  const [scope, setScope] = useState<SkillScope>("global")
  const [installed, setInstalled] = useState<InstalledSkill[]>([])
  const [available, setAvailable] = useState<SkillInfo[]>([])
  const [source, setSource] = useState(DEFAULT_SOURCE)
  const [sourceInput, setSourceInput] = useState(DEFAULT_SOURCE)
  const [filter, setFilter] = useState("")
  const [loadingInstalled, setLoadingInstalled] = useState(true)
  const [loadingAvailable, setLoadingAvailable] = useState(false)
  const [installingNames, setInstallingNames] = useState<Set<string>>(new Set())
  const [removingNames, setRemovingNames] = useState<Set<string>>(new Set())
  const [updatingNames, setUpdatingNames] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  // Losing the project (closed, switched away) must not strand the page on a scope it
  // can no longer load.
  useEffect(() => {
    if (scope === "project" && !projectPath) setScope("global")
  }, [scope, projectPath])

  const loadInstalled = useCallback(async () => {
    setLoadingInstalled(true)
    try {
      const res = await api.skillListInstalled(scope, projectPath)
      if (res.error) throw new Error(res.error)
      setInstalled(res.skills ?? [])
    } catch (err) {
      setError(`Failed to load installed skills: ${err instanceof Error ? err.message : String(err)}`)
      setInstalled([])
    } finally {
      setLoadingInstalled(false)
    }
  }, [scope, projectPath])

  const loadAvailable = useCallback(async (src: string, refresh = false) => {
    setLoadingAvailable(true)
    setError(null)
    try {
      const res = await api.skillListAvailable(src, refresh)
      if (res.error) throw new Error(res.error)
      setAvailable(res.skills ?? [])
    } catch (err) {
      setError(`Failed to load skills from ${src}: ${err instanceof Error ? err.message : String(err)}`)
      setAvailable([])
    } finally {
      setLoadingAvailable(false)
    }
  }, [])

  useEffect(() => {
    void loadInstalled()
  }, [loadInstalled])

  useEffect(() => {
    void loadAvailable(DEFAULT_SOURCE)
  }, [loadAvailable])

  const handleLoadSource = () => {
    const trimmed = sourceInput.trim()
    if (!trimmed) return
    setSource(trimmed)
    void loadAvailable(trimmed)
  }

  const withPending = async (
    name: string,
    setPending: React.Dispatch<React.SetStateAction<Set<string>>>,
    run: () => Promise<void>,
  ) => {
    setPending((prev) => new Set(prev).add(name))
    setError(null)
    setNotice(null)
    try {
      await run()
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
    }
  }

  /** `targetScope` lets the split button install into the scope that isn't selected. */
  const handleInstall = async (skillName: string, targetScope: SkillScope = scope) => {
    await withPending(skillName, setInstallingNames, async () => {
      try {
        const res = await api.skillInstall({
          source,
          skillName,
          scope: targetScope,
          workspacePath: targetScope === "project" ? projectPath : undefined,
        })
        if (res.error) throw new Error(res.error)
        if (res.output) setNotice(res.output)
        // Installing into the other scope leaves this list unchanged, but the shadow
        // flags depend on both scopes, so reload either way.
        await loadInstalled()
      } catch (err) {
        setError(`Failed to install ${skillName}: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  const handleUpdate = async (skillName: string) => {
    await withPending(skillName, setUpdatingNames, async () => {
      try {
        const res = await api.skillUpdate({
          skillName,
          scope,
          workspacePath: scope === "project" ? projectPath : undefined,
        })
        if (res.error) throw new Error(res.error)

        // The server refuses to clobber local edits until the user says so.
        if (res.needsForce) {
          const confirmed = window.confirm(
            intl.formatMessage(
              {
                id: "skill.updateOverwriteConfirm",
                defaultMessage:
                  '"{name}" has local edits. Updating will overwrite them. Continue?',
              },
              { name: skillName },
            ),
          )
          if (!confirmed) return
          const forced = await api.skillUpdate({
            skillName,
            scope,
            workspacePath: scope === "project" ? projectPath : undefined,
            force: true,
          })
          if (forced.error) throw new Error(forced.error)
          if (forced.output) setNotice(forced.output)
        } else if (res.output) {
          setNotice(res.output)
        }
        await loadInstalled()
      } catch (err) {
        setError(`Failed to update ${skillName}: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  const handleRemove = async (skillName: string) => {
    const confirmed = window.confirm(
      intl.formatMessage({ id: "skill.uninstallConfirm", defaultMessage: 'Uninstall skill "{name}"?' }, { name: skillName }),
    )
    if (!confirmed) return
    await withPending(skillName, setRemovingNames, async () => {
      try {
        const res = await api.skillRemove({
          skillName,
          scope,
          workspacePath: scope === "project" ? projectPath : undefined,
        })
        if (res.error) throw new Error(res.error)
        if (res.output) setNotice(res.output)
        await loadInstalled()
      } catch (err) {
        setError(`Failed to uninstall ${skillName}: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  const installedNames = useMemo(() => new Set(installed.map((s) => s.name)), [installed])

  const installedItems = useMemo<SkillListItem[]>(
    () =>
      installed.map((s) => ({
        name: s.name,
        description: s.description ?? "",
        installed: true,
        path: s.path,
        source: s.source,
        updatedAt: s.updatedAt,
        agents: s.agents,
        shadowed: s.shadowed,
      })),
    [installed],
  )

  // The library lists what the source offers; already-installed entries stay visible
  // (marked as such) so the source keeps its full catalogue.
  const libraryItems = useMemo<SkillListItem[]>(
    () =>
      available.map((s) => ({
        name: s.name,
        description: s.description,
        installed: installedNames.has(s.name),
      })),
    [available, installedNames],
  )

  const matches = useCallback(
    (item: SkillListItem) => {
      const q = filter.trim().toLowerCase()
      if (!q) return true
      return item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)
    },
    [filter],
  )

  const shownInstalled = useMemo(() => installedItems.filter(matches), [installedItems, matches])
  const shownLibrary = useMemo(() => libraryItems.filter(matches), [libraryItems, matches])

  const refreshAll = () => {
    void loadInstalled()
    void loadAvailable(source, true)
  }

  const selectedItem = useMemo(
    () => [...installedItems, ...libraryItems].find((s) => s.name === selected) ?? null,
    [installedItems, libraryItems, selected],
  )

  const otherScope: SkillScope = scope === "global" ? "project" : "global"
  const canUseOtherScope = otherScope === "global" || Boolean(projectPath)

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground">
      <div className="h-10 drag-region shrink-0 bg-background" />

      {/* Header — Back is contextual: it leaves the detail view before leaving the page. */}
      <div className="h-14 shrink-0 border-b border-border/40 flex items-center justify-between px-6 bg-background/80 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 gap-1.5 rounded-lg px-2.5 text-muted-foreground hover:text-foreground"
            onClick={() => (selected ? setSelected(null) : onBack())}
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="text-sm font-medium">
              {intl.formatMessage({ id: "common.back", defaultMessage: "Back" })}
            </span>
          </Button>
          <div className="h-4 w-px bg-border/60" />
          <div className="flex min-w-0 items-center gap-1.5 text-sm">
            <button
              type="button"
              className={cn(
                "font-semibold tracking-tight transition-colors",
                selected ? "text-muted-foreground hover:text-foreground" : "text-foreground",
              )}
              onClick={() => setSelected(null)}
              disabled={!selected}
            >
              {intl.formatMessage({ id: "skill.title", defaultMessage: "Skills" })}
            </button>
            {selected && (
              <>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                <span className="truncate font-semibold tracking-tight">{selected}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ScopeSwitcher
            scope={scope}
            onChange={setScope}
            projectName={projectName}
            projectAvailable={Boolean(projectPath)}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg"
            onClick={refreshAll}
            disabled={loadingInstalled || loadingAvailable}
            title={intl.formatMessage({ id: "common.refresh", defaultMessage: "Refresh" })}
          >
            {loadingInstalled || loadingAvailable ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto code-scrollbar">
        {selected ? (
          <SkillDetailView
            key={`${scope}:${selected}`}
            name={selected}
            source={source}
            scope={scope}
            workspacePath={projectPath}
            installed={installedNames.has(selected)}
            fallbackDescription={selectedItem?.description ?? ""}
            agents={selectedItem?.agents ?? []}
            installing={installingNames.has(selected)}
            removing={removingNames.has(selected)}
            updating={updatingNames.has(selected)}
            canUpdate={Boolean(selectedItem?.source)}
            onInstall={() => void handleInstall(selected)}
            onRemove={() => void handleRemove(selected)}
            onUpdate={() => void handleUpdate(selected)}
          />
        ) : (
          <div className="mx-auto max-w-4xl px-8 py-7 space-y-8">
            {scope === "project" && projectPath && <ProjectScopeHint path={projectPath} />}

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 break-words">{error}</span>
              </div>
            )}

            {notice && !error && (
              <div className="flex items-start gap-2 rounded-lg border border-status-ok/15 bg-status-ok/10 p-3 text-xs text-status-ok">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 break-words">{notice}</span>
              </div>
            )}

            <FilterInput value={filter} onChange={setFilter} />

            <SkillSection
              title={intl.formatMessage({ id: "skill.installed.title", defaultMessage: "Installed" })}
              count={installedItems.length}
              loading={loadingInstalled}
              empty={
                scope === "project"
                  ? intl.formatMessage({
                      id: "skill.installed.emptyProject",
                      defaultMessage: "No skills in this project yet — install one from the library below.",
                    })
                  : intl.formatMessage({
                      id: "skill.installed.empty",
                      defaultMessage: "No skills installed yet — pick one from the library below.",
                    })
              }
              items={shownInstalled}
              scope={scope}
              otherScope={canUseOtherScope ? otherScope : null}
              installingNames={installingNames}
              removingNames={removingNames}
              updatingNames={updatingNames}
              onOpen={setSelected}
              onInstall={handleInstall}
              onRemove={handleRemove}
              onUpdate={handleUpdate}
            />

            <SkillSection
              title={intl.formatMessage({ id: "skill.browse.title", defaultMessage: "Library" })}
              subtitle={source}
              toolbar={
                <SourceInput
                  value={sourceInput}
                  loading={loadingAvailable}
                  onChange={setSourceInput}
                  onLoad={handleLoadSource}
                />
              }
              count={libraryItems.length}
              loading={loadingAvailable}
              empty={intl.formatMessage({
                id: "skill.browse.empty",
                defaultMessage: "No skills found. Try a different source repository.",
              })}
              items={shownLibrary}
              scope={scope}
              otherScope={canUseOtherScope ? otherScope : null}
              installingNames={installingNames}
              removingNames={removingNames}
              updatingNames={updatingNames}
              onOpen={setSelected}
              onInstall={handleInstall}
              onRemove={handleRemove}
              onUpdate={handleUpdate}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ── Scope: which set of directories the whole page is talking about ──────────
function ScopeSwitcher({
  scope,
  onChange,
  projectName,
  projectAvailable,
}: {
  scope: SkillScope
  onChange: (scope: SkillScope) => void
  projectName?: string
  projectAvailable: boolean
}) {
  const intl = useIntl()
  const options: { value: SkillScope; label: string; icon: typeof Globe; disabled?: boolean }[] = [
    {
      value: "global",
      label: intl.formatMessage({ id: "skill.scope.global", defaultMessage: "Global" }),
      icon: Globe,
    },
    {
      value: "project",
      label: projectName ?? intl.formatMessage({ id: "skill.scope.project", defaultMessage: "Project" }),
      icon: FolderGit2,
      disabled: !projectAvailable,
    },
  ]

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border/50 bg-muted/20 p-0.5">
      {options.map((option) => {
        const Icon = option.icon
        const active = scope === option.value
        return (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            title={
              option.disabled
                ? intl.formatMessage({
                    id: "skill.scope.noProject",
                    defaultMessage: "Open a project to install skills into it",
                  })
                : undefined
            }
            className={cn(
              "flex h-7 max-w-[160px] items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-tab"
                : "text-muted-foreground hover:text-foreground",
              option.disabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Project installs write into the user's repository, which the CLI equivalent makes
 * obvious by running in that directory and this GUI does not. Say it once, up front.
 */
function ProjectScopeHint({ path }: { path: string }) {
  const intl = useIntl()
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
      <FolderGit2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        <code className="font-mono text-foreground">{path}/.agents/skills</code>{" "}
        {intl.formatMessage({
          id: "skill.scope.projectHint",
          defaultMessage:
            "— project skills are written into the repository and will show up in git status. Commit them to share the set with your team.",
        })}
      </span>
    </div>
  )
}

// ── Filter: page-level, narrows both Installed and Library ───────────────────
function FilterInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const intl = useIntl()
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={intl.formatMessage({
          id: "skill.filter.placeholder",
          defaultMessage: "Filter installed and library skills…",
        })}
        className="h-9 border-border/50 bg-background pl-9 text-sm shadow-none"
      />
    </div>
  )
}

// ── Source: scoped to the Library section, which is all it affects ───────────
function SourceInput({
  value,
  loading,
  onChange,
  onLoad,
}: {
  value: string
  loading: boolean
  onChange: (value: string) => void
  onLoad: () => void
}) {
  const intl = useIntl()
  return (
    <div className="flex gap-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onLoad()
        }}
        placeholder="owner/repo"
        className="h-8 flex-1 border-border/50 bg-background font-mono text-xs shadow-none"
        spellCheck={false}
      />
      <Button
        size="sm"
        variant="secondary"
        className="h-8 shrink-0 gap-1.5"
        onClick={onLoad}
        disabled={loading || !value.trim()}
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        {intl.formatMessage({ id: "skill.browse.loadSource", defaultMessage: "Load" })}
      </Button>
    </div>
  )
}

// ── One list section (Installed / Library) ───────────────────────────────────
function SkillSection({
  title,
  subtitle,
  count,
  loading,
  toolbar,
  empty,
  items,
  scope,
  otherScope,
  installingNames,
  removingNames,
  updatingNames,
  onOpen,
  onInstall,
  onRemove,
  onUpdate,
}: {
  title: string
  subtitle?: string
  /** Section-scoped controls, rendered under the heading (Library's source input). */
  toolbar?: React.ReactNode
  count: number
  loading: boolean
  empty: string
  items: SkillListItem[]
  scope: SkillScope
  /** The scope the split button offers as a secondary target, if one is usable. */
  otherScope: SkillScope | null
  installingNames: Set<string>
  removingNames: Set<string>
  updatingNames: Set<string>
  onOpen: (name: string) => void
  onInstall: (name: string, scope?: SkillScope) => void
  onRemove: (name: string) => void
  onUpdate: (name: string) => void
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {!loading && count > 0 && <span className="text-xs text-muted-foreground">{count}</span>}
        {subtitle && (
          <span className="truncate font-mono text-[11px] text-muted-foreground/70">{subtitle}</span>
        )}
      </div>

      {toolbar}

      {loading ? (
        <SkillListSkeleton />
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/50 p-6 text-center text-xs text-muted-foreground">
          {count > 0 ? "No skills match the filter." : empty}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {items.map((item) => (
            <SkillCard
              key={item.name}
              item={item}
              scope={scope}
              otherScope={otherScope}
              installing={installingNames.has(item.name)}
              removing={removingNames.has(item.name)}
              updating={updatingNames.has(item.name)}
              onOpen={() => onOpen(item.name)}
              onInstall={(target) => onInstall(item.name, target)}
              onRemove={() => onRemove(item.name)}
              onUpdate={() => onUpdate(item.name)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function SkillListSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-[68px] animate-pulse rounded-xl border border-border/40 bg-muted/30" />
      ))}
    </div>
  )
}

// ── Skill card: the whole card opens the preview ─────────────────────────────
function SkillCard({
  item,
  scope,
  otherScope,
  installing,
  removing,
  updating,
  onOpen,
  onInstall,
  onRemove,
  onUpdate,
}: {
  item: SkillListItem
  scope: SkillScope
  otherScope: SkillScope | null
  installing: boolean
  removing: boolean
  updating: boolean
  onOpen: () => void
  onInstall: (scope?: SkillScope) => void
  onRemove: () => void
  onUpdate: () => void
}) {
  const intl = useIntl()
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        "group flex cursor-pointer items-start gap-3 rounded-xl border border-border/60 bg-popover/95 p-3 text-left",
        "shadow-card transition-colors hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
      )}
    >
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-tint-muted text-tint">
        <Package className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{item.name}</span>
          {item.installed && <Check className="h-3.5 w-3.5 shrink-0 text-tint" />}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {item.description || intl.formatMessage({ id: "skill.noDescription", defaultMessage: "No description." })}
        </p>
        {item.installed && <SkillCardMeta item={item} />}
      </div>
      {item.installed ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {item.source && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 shrink-0 text-muted-foreground/60 hover:text-foreground"
              disabled={updating}
              title={intl.formatMessage({ id: "skill.update", defaultMessage: "Update" })}
              onClick={(e) => {
                e.stopPropagation()
                onUpdate()
              }}
            >
              {updating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 shrink-0 text-muted-foreground/60 hover:text-destructive"
            disabled={removing}
            title={intl.formatMessage({ id: "skill.uninstall", defaultMessage: "Uninstall" })}
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
          >
            {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        </div>
      ) : (
        <InstallButton
          scope={scope}
          otherScope={otherScope}
          installing={installing}
          onInstall={onInstall}
        />
      )}
    </div>
  )
}

/** Provenance line: where it came from, when, and who can see it. */
function SkillCardMeta({ item }: { item: SkillListItem }) {
  const intl = useIntl()
  const agentCount = item.agents?.length ?? 0

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground/70">
      {item.source && (
        <span className="inline-flex min-w-0 items-center gap-1" title={item.source}>
          <Package className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono">{item.source}</span>
        </span>
      )}
      {item.updatedAt && <span className="shrink-0">{formatRelativeTime(item.updatedAt)}</span>}
      {agentCount > 0 && <AgentBadges agents={item.agents!} />}
      {item.shadowed && (
        <Badge
          variant="outline"
          className="gap-1 border-status-warn/15 bg-status-warn/10 px-1.5 py-0 text-[10px] font-normal text-status-warn"
          title={intl.formatMessage({
            id: "skill.shadowedHint",
            defaultMessage:
              "A project skill with this name takes priority — agents will load that one instead.",
          })}
        >
          <AlertTriangle className="h-2.5 w-2.5" />
          {intl.formatMessage({ id: "skill.shadowed", defaultMessage: "Shadowed by project" })}
        </Badge>
      )}
    </div>
  )
}

/**
 * Install into the current scope, with the other scope one click away.
 *
 * Collapses to a plain button when there is no second scope to offer, so a user
 * without a project open never sees a dropdown with one item in it.
 */
function InstallButton({
  scope,
  otherScope,
  installing,
  onInstall,
}: {
  scope: SkillScope
  otherScope: SkillScope | null
  installing: boolean
  onInstall: (scope?: SkillScope) => void
}) {
  const intl = useIntl()
  const label = intl.formatMessage({ id: "skill.install", defaultMessage: "Install" })

  const primary = (
    <Button
      size="sm"
      variant="ghost"
      className={cn("h-7 shrink-0 gap-1.5 text-xs text-muted-foreground", otherScope && "pr-1")}
      disabled={installing}
      onClick={(e) => {
        e.stopPropagation()
        onInstall(scope)
      }}
    >
      {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      {label}
    </Button>
  )

  if (!otherScope) return primary

  return (
    <div className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
      {primary}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-6 shrink-0 px-0 text-muted-foreground/60 hover:text-foreground"
            disabled={installing}
            title={intl.formatMessage({ id: "skill.installElsewhere", defaultMessage: "Install elsewhere" })}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[200px]">
          <DropdownMenuItem onClick={() => onInstall(otherScope)} className="gap-2 text-xs">
            {otherScope === "global" ? (
              <Globe className="h-3.5 w-3.5" />
            ) : (
              <FolderGit2 className="h-3.5 w-3.5" />
            )}
            {otherScope === "global"
              ? intl.formatMessage({ id: "skill.installGlobal", defaultMessage: "Install globally" })
              : intl.formatMessage({ id: "skill.installProject", defaultMessage: "Install into this project" })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Coarse relative time — the exact minute never matters for an install date. */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

// ── Detail: the rendered SKILL.md, read from the install or the source repo ──
function SkillDetailView({
  name,
  source,
  scope,
  workspacePath,
  installed,
  fallbackDescription,
  agents,
  installing,
  removing,
  updating,
  canUpdate,
  onInstall,
  onRemove,
  onUpdate,
}: {
  name: string
  source: string
  scope: SkillScope
  workspacePath?: string
  installed: boolean
  fallbackDescription: string
  /** Agents this skill is installed for; empty when previewing from the library. */
  agents: string[]
  installing: boolean
  removing: boolean
  updating: boolean
  canUpdate: boolean
  onInstall: () => void
  onRemove: () => void
  onUpdate: () => void
}) {
  const intl = useIntl()
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Reload after install/uninstall so the preview switches between the installed
  // copy and the source repo copy.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const res = await api.skillDetail(name, source, scope, workspacePath)
        if (cancelled) return
        if (res.error) throw new Error(res.error)
        setDetail(res.detail ?? null)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [name, source, scope, workspacePath, installed, updating])

  const description = detail?.description || fallbackDescription

  return (
    <div className="mx-auto max-w-3xl px-8 py-7 space-y-6">
      <header className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-tint-muted text-tint">
            <Package className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold tracking-tight">{name}</h1>
            {description && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>}
          </div>
          {installed ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {canUpdate && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
                  disabled={updating}
                  onClick={onUpdate}
                >
                  {updating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {intl.formatMessage({ id: "skill.update", defaultMessage: "Update" })}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 text-muted-foreground hover:text-destructive"
                disabled={removing}
                onClick={onRemove}
              >
                {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {intl.formatMessage({ id: "skill.uninstall", defaultMessage: "Uninstall" })}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" className="h-8 shrink-0 gap-1.5" disabled={installing} onClick={onInstall}>
              {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {intl.formatMessage({ id: "skill.install", defaultMessage: "Install" })}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {installed && (
            <Badge variant="outline" className="gap-1 border-border/50 bg-tint-muted px-2 py-0.5 text-[11px] font-normal text-tint">
              <Check className="h-3 w-3" />
              {intl.formatMessage({ id: "skill.badge.installed", defaultMessage: "Installed" })}
            </Badge>
          )}
          <Badge
            variant="outline"
            className="gap-1 border-border/50 px-2 py-0.5 text-[11px] font-normal text-muted-foreground"
          >
            {scope === "global" ? <Globe className="h-3 w-3" /> : <FolderGit2 className="h-3 w-3" />}
            {scope === "global"
              ? intl.formatMessage({ id: "skill.scope.global", defaultMessage: "Global" })
              : intl.formatMessage({ id: "skill.scope.project", defaultMessage: "Project" })}
          </Badge>
          {detail?.path && (
            <Badge
              variant="outline"
              className="max-w-full border-border/50 px-2 py-0.5 font-mono text-[11px] font-normal text-muted-foreground"
              title={detail.path}
            >
              <span className="truncate">{detail.path}</span>
            </Badge>
          )}
          {detail && Object.entries(detail.metadata).map(([key, value]) => (
            <Badge
              key={key}
              variant="outline"
              className="max-w-full border-border/50 px-2 py-0.5 text-[11px] font-normal text-muted-foreground"
              title={`${key}: ${value}`}
            >
              <span className="truncate">
                {key}: {value}
              </span>
            </Badge>
          ))}
        </div>

        {installed && agents.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground/70">
              {intl.formatMessage({ id: "skill.availableIn", defaultMessage: "Available in" })}
            </span>
            <AgentChips agents={agents} />
          </div>
        )}
      </header>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {intl.formatMessage({ id: "skill.detail.loading", defaultMessage: "Loading SKILL.md…" })}
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : detail ? (
        <>
          <div className="rounded-xl border border-border/60 bg-popover/95 p-5 shadow-card">
            {detail.content ? (
              <MarkdownRenderer content={detail.content} />
            ) : (
              <p className="text-xs text-muted-foreground">
                {intl.formatMessage({ id: "skill.detail.emptyBody", defaultMessage: "SKILL.md has no body content." })}
              </p>
            )}
          </div>

          {detail.files.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold text-muted-foreground">
                {intl.formatMessage(
                  { id: "skill.detail.files", defaultMessage: "Bundled files ({count})" },
                  { count: detail.files.length },
                )}
              </h2>
              <div className="divide-y divide-border/40 rounded-xl border border-border/60 bg-popover/95 px-3 shadow-card">
                {detail.files.map((file) => (
                  <div key={file.path} className="flex items-center gap-2 py-2 text-xs">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                    <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                    <span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      ) : null}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
