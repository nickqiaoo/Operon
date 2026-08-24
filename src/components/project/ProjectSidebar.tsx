import { api } from "@/lib/api"
import { openExternalUrl } from "@/lib/open-external"
import { CalendarClock, GitBranch, Inbox, Plus, Settings, Sparkles, Network, LayoutDashboard, Bot, PanelLeft } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { useIntl, FormattedMessage } from "react-intl"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useProjectStore, Project, Workspace, WorkspaceDiffStat } from "@/stores/project-store"
import { useEditorStore } from "@/stores/editor-store"
import type { EditorTab } from "@/types/editor"
import { useStreamingStore } from "@/stores/streaming-store"
import { useInboxStore } from "@/stores/inbox-store"
import { UpdateReadyPill } from "@/components/update/UpdateReadyPill"
import { NewWorkspaceDialog } from "./NewWorkspaceDialog"

type GitWorktreeEntry = {
  path: string
  branch: string | null
  head: string | null
  detached: boolean
}

interface ProjectItemProps {
  project: Project
  onSelectWorkspace: (workspaceId: number, projectId: number) => void
  activeWorkspaceId?: number | null
  onAddWorkspace: (project: Project) => void
  onOpenChannel?: (project: Project) => void
  error?: string | null
  workspaceDiffStats?: Record<string, WorkspaceDiffStat>
  streamingCounts?: Record<number, number>
  unseenCounts?: Record<number, number>
}

const getBasename = (filePath: string) => {
  const normalized = filePath.replace(/[\\/]+$/, "")
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] || normalized
}

const normalizeBranchName = (branch: string | null, detached: boolean) => {
  if (branch) {
    return branch.replace(/^refs\/heads\//, "")
  }
  return detached ? "detached" : "unknown"
}

const buildWorkspaceInputs = (entries: GitWorktreeEntry[], fallbackRoot: string): Array<Omit<Workspace, "id">> => {
  if (entries.length === 0) {
    return [
      {
        name: getBasename(fallbackRoot),
        branchName: "main",
        worktreePath: fallbackRoot
      }
    ]
  }
  return entries.map((entry) => {
    const branchName = normalizeBranchName(entry.branch, entry.detached)
    const name = branchName === "detached" ? getBasename(entry.path) : branchName
    return {
      name,
      branchName,
      worktreePath: entry.path
    }
  })
}

function ProjectItem({
  project,
  onSelectWorkspace,
  activeWorkspaceId,
  onAddWorkspace,
  onOpenChannel,
  error,
  workspaceDiffStats,
  streamingCounts,
  unseenCounts,
}: ProjectItemProps) {
  const intl = useIntl()
  return (
    <div className="group/project px-4">
      <div className="flex items-center gap-2 pb-1 text-sm text-foreground/80 font-medium">
        <span className="size-2 shrink-0 rounded-full bg-tint" />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-full bg-transparent text-muted-foreground opacity-0 transition-opacity hover:bg-muted/70 hover:text-foreground group-hover/project:opacity-100 focus-visible:opacity-100"
          onClick={() => onOpenChannel?.(project)}
          title={intl.formatMessage({ id: "sidebar.openChannels", defaultMessage: "Open workspace" })}
        >
          <LayoutDashboard className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-full bg-transparent text-muted-foreground opacity-0 transition-opacity hover:bg-muted/70 hover:text-foreground group-hover/project:opacity-100 focus-visible:opacity-100"
          onClick={() => onAddWorkspace(project)}
          title={intl.formatMessage({ id: "sidebar.newWorkspace", defaultMessage: "New workspace" })}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && (
        <div className="mb-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div>
        {project.workspaces.length === 0 ? (
          <div className="rounded-xl bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
            No workspaces yet.
          </div>
        ) : (
          project.workspaces.map((workspace) => {
            const isActive = activeWorkspaceId === workspace.id
            const workspaceStats = workspaceDiffStats?.[workspace.worktreePath]
            const wsStreaming = streamingCounts?.[workspace.id] ?? 0
            const wsUnseen = unseenCounts?.[workspace.id] ?? 0
            const wsBadge = wsStreaming + wsUnseen
            return (
              <button
                key={workspace.id}
                onClick={() => onSelectWorkspace(workspace.id, project.id)}
                className={cn(
                  "w-full rounded-lg px-3 py-2 text-left transition-colors duration-150 bg-transparent hover:bg-muted/60 hover:text-foreground relative overflow-hidden",
                  // Selection is a plain fill — no border, no tint. `tint-muted`
                  // only cleared the sidebar by ~9 levels and skewed blue, so the
                  // block read as a smudge; a neutral 7% of the foreground lands
                  // ~15 levels down and stays right in dark mode and under every
                  // UI theme, since it composites against whatever the surface is.
                  isActive && "bg-foreground/[0.07] text-foreground shadow-none hover:bg-foreground/[0.07]",
                  wsStreaming > 0 && "animate-shimmer-sweep"
                )}
              >
                <div className="flex items-center gap-2 relative z-[1]">
                  {workspace.name.endsWith(' (agent)')
                    ? <Bot className={cn("size-4 shrink-0 text-muted-foreground", isActive && "text-tint")} strokeWidth={isActive ? 2 : 1.5} />
                    : <GitBranch className={cn("size-4 shrink-0 text-muted-foreground", isActive && "text-tint")} strokeWidth={isActive ? 2 : 1.5} />
                  }
                  <span className={cn("min-w-0 flex-1 truncate text-sm", isActive ? "font-semibold text-foreground" : "font-medium text-muted-foreground")}>
                    {workspace.name}
                  </span>
                  {workspaceStats && (workspaceStats.additions > 0 || workspaceStats.deletions > 0) && (
                    <span className="shrink-0 text-[11px] font-mono tabular-nums font-normal opacity-80">
                      {workspaceStats.additions > 0 && (
                        <span className="text-green-600">+{workspaceStats.additions}</span>
                      )}
                      {workspaceStats.deletions > 0 && (
                        <span className="text-red-600 ml-0.5">-{workspaceStats.deletions}</span>
                      )}
                    </span>
                  )}
                  {wsBadge > 0 && (
                    <span className={cn(
                      "shrink-0 text-[11px] font-medium tabular-nums leading-none",
                      wsStreaming > 0 ? "text-blue-500" : "text-amber-500"
                    )}>
                      {wsBadge}
                    </span>
                  )}
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

/** Placeholder tree while the first `loadProjects` is in flight. */
function WorkspaceListSkeleton() {
  return (
    <div className="px-4" aria-hidden>
      {[3, 2].map((workspaceCount, projectIndex) => (
        <div key={projectIndex} className="pb-3" style={{ opacity: 1 - projectIndex * 0.35 }}>
          <div className="flex items-center gap-2 pb-1">
            <Skeleton className="size-2 shrink-0 rounded-full" />
            <Skeleton className="h-3.5 w-24" />
          </div>
          {Array.from({ length: workspaceCount }, (_, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2">
              <Skeleton className="size-4 shrink-0 rounded" />
              <Skeleton className="h-3.5 flex-1" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

interface ProjectSidebarProps {
  onOpenSettings: () => void
  onOpenCronjobs: () => void
  onOpenSkills: () => void
  onOpenCanvas: () => void
  onOpenChannel?: (project: Project) => void
  onOpenInbox?: () => void
  onCollapse?: () => void
  collapsed?: boolean
}

export function ProjectSidebar({ onOpenSettings, onOpenCronjobs, onOpenSkills, onOpenCanvas, onOpenChannel, onOpenInbox, onCollapse, collapsed }: ProjectSidebarProps) {
  const intl = useIntl()
  const canAddProject = __APP_TARGET__ !== "web"
  const projects = useProjectStore((s) => s.projects)
  const projectsLoaded = useProjectStore((s) => s.projectsLoaded)
  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)
  const addProject = useProjectStore((s) => s.addProject)
  const addWorkspace = useProjectStore((s) => s.addWorkspace)
  const setActiveWorkspace = useProjectStore((s) => s.setActiveWorkspace)
  const setProjectWorkspaces = useProjectStore((s) => s.setProjectWorkspaces)
  const workspaceDiffStats = useProjectStore((s) => s.workspaceDiffStats)
  const [projectErrors, setProjectErrors] = useState<Record<string, string | null>>({})

  // Compute per-workspace streaming & unseen counts
  const workspaceStates = useEditorStore((s) => s.workspaceStates)
  const currentWorkspaceId = useEditorStore((s) => s.currentWorkspaceId)
  const currentTabs = useEditorStore((s) => s.tabs)
  const streamingTabIds = useStreamingStore((s) => s.streamingTabIds)
  const unseenTabIds = useStreamingStore((s) => s.unseenTabIds)
  const clearUnseen = useStreamingStore((s) => s.clearUnseen)
  const inboxAction = useInboxStore((s) => s.counts.action)
  const inboxTotal = useInboxStore((s) => s.counts.total)

  const getWorkspaceTabs = useCallback((wsId: number): EditorTab[] => {
    if (wsId === currentWorkspaceId) return currentTabs
    return workspaceStates[String(wsId)]?.tabs ?? []
  }, [workspaceStates, currentWorkspaceId, currentTabs])

  const { streamingCounts, unseenCounts } = useMemo(() => {
    const sc: Record<number, number> = {}
    const uc: Record<number, number> = {}
    const allWsIds = new Set<number>()

    for (const key of Object.keys(workspaceStates)) {
      const wsId = Number(key)
      if (!Number.isNaN(wsId)) allWsIds.add(wsId)
    }
    if (currentWorkspaceId) allWsIds.add(currentWorkspaceId)

    for (const wsId of allWsIds) {
      const tabs = wsId === currentWorkspaceId ? currentTabs : (workspaceStates[String(wsId)]?.tabs ?? [])
      const chatTabs = tabs.filter((t) => t.type === "chat")
      sc[wsId] = chatTabs.filter((t) => streamingTabIds.has(t.id)).length
      uc[wsId] = chatTabs.filter((t) => unseenTabIds.has(t.id)).length
    }
    return { streamingCounts: sc, unseenCounts: uc }
  }, [workspaceStates, currentWorkspaceId, currentTabs, streamingTabIds, unseenTabIds])

  // Clear unseen when user switches to a workspace
  const handleSelectWorkspace = useCallback((workspaceId: number, projectId: number) => {
    const tabs = getWorkspaceTabs(workspaceId)
    const chatTabIds = tabs.filter((t) => t.type === "chat").map((t) => t.id)
    if (chatTabIds.length > 0) clearUnseen(chatTabIds)
    setActiveWorkspace(workspaceId, projectId)
  }, [getWorkspaceTabs, clearUnseen, setActiveWorkspace])

  const syncWorktrees = async (project: Project) => {
    try {
      const result = await api.workspaceList(project.id)
      setProjectWorkspaces(project.id, result.workspaces)
      setProjectErrors((prev) => ({ ...prev, [String(project.id)]: null }))
    } catch (error) {
      console.error("Failed to sync worktrees:", error)
      setProjectErrors((prev) => ({ ...prev, [String(project.id)]: "Failed to sync workspaces." }))
    }
  }

  const handleAddProject = async () => {
    if (!canAddProject) return

    const folderPath = await api.selectFolder()
    if (folderPath) {
      const name = getBasename(folderPath) || "New Project"
      let workspaces = buildWorkspaceInputs([], folderPath)
      try {
        const entries = await api.gitWorktreeList(folderPath)
        workspaces = buildWorkspaceInputs(entries, folderPath)
      } catch (error) {
        console.error("Failed to load worktrees:", error)
      }
      const createdProject = await addProject({
        name,
        rootPath: folderPath,
        workspaces
      })
      setProjectErrors((prev) => ({ ...prev, [String(createdProject.id)]: null }))
    }
  }

  const [newWorkspaceProjectId, setNewWorkspaceProjectId] = useState<number | null>(null)

  const handleOpenAddWorkspace = (project: Project) => {
    setNewWorkspaceProjectId(project.id)
  }

  const handleConfirmAddWorkspace = async (branchName: string) => {
    if (newWorkspaceProjectId === null) return

    // Find project safely
    const project = projects.find(p => p.id === newWorkspaceProjectId)
    if (!project) return

    const safeBranch = branchName.replace(/[^a-zA-Z0-9._-]+/g, "-")

    try {
      // Server places it under operon's managed worktrees dir
      // (~/.operon/worktrees/<id>-<repo>/<name>) and returns the absolute path.
      const worktreePath = await api.gitWorktreeAdd(
        project.rootPath,
        "",
        branchName,
        true,
        undefined,
        { projectId: project.id, name: safeBranch }
      )
      await addWorkspace(project.id, {
        name: safeBranch || branchName,
        branchName,
        worktreePath,
      })
      await syncWorktrees(project)
    } catch (error) {
      console.error("Failed to add worktree:", error)
      setProjectErrors((prev) => ({ ...prev, [String(project.id)]: "Failed to create worktree." }))
      throw error
    }
  }




  return (
    <div className="h-full flex flex-col bg-sidebar text-sidebar-foreground">
      {/* Top Drag Region. pl-20 reserves room for the macOS traffic lights — only
          on the desktop app; the web build has no window controls, so it would
          otherwise be an empty gap. */}
      <div className={`h-10 px-4 ${__APP_TARGET__ !== 'web' ? 'pl-20 ' : ''}border-b border-border/40 bg-sidebar flex items-center justify-start drag-region shrink-0`}>
        {onCollapse && !collapsed && (
          <button
            className="no-drag flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
            style={{ viewTransitionName: "sidebar-trigger" }}
            onClick={onCollapse}
            title={intl.formatMessage({ id: "sidebar.collapse", defaultMessage: "Collapse sidebar" })}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Global destinations */}
      {onOpenInbox && (
        <div className="px-2 pt-2 shrink-0">
          <button
            type="button"
            onClick={onOpenInbox}
            className="w-full flex items-center gap-2 px-2 py-2 text-sm font-medium rounded-lg transition-colors text-left text-foreground/85 hover:bg-muted/60 hover:text-foreground"
          >
            <Inbox className="h-4 w-4" />
            <span className="flex-1"><FormattedMessage id="sidebar.inbox" defaultMessage="Inbox" /></span>
            {inboxAction > 0 ? (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-medium leading-none text-white">
                {inboxAction > 99 ? "99+" : inboxAction}
              </span>
            ) : inboxTotal > 0 ? (
              <span className="px-1 text-xs font-semibold leading-none text-tint tabular-nums">
                {inboxTotal > 99 ? "99+" : inboxTotal}
              </span>
            ) : null}
          </button>
        </div>
      )}

      {/* Secondary Header */}
      <div className="h-10 px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 heading-section">
          <span><FormattedMessage id="sidebar.workspaces" defaultMessage="Workspaces" /></span>
        </div>
        {canAddProject && (
          <Button
            variant="secondary"
            size="sm"
            className="h-6 px-2 text-xs shadow-none border border-border/50 transition-colors hover:bg-tint-muted hover:text-tint hover:border-tint/20"
            onClick={handleAddProject}
            title={intl.formatMessage({ id: "sidebar.addRepository", defaultMessage: "Add repository" })}
          >
            New
          </Button>
        )}
      </div>
      <ScrollArea className="flex-1 min-h-0 [&>[data-slot=scroll-area-viewport]>div]:!block [&>[data-slot=scroll-area-viewport]>div]:!min-w-0">
        <div className="space-y-1 pb-6 pt-0">
          {projects.length === 0 && !projectsLoaded ? (
            // First load with nothing cached. Without this the empty state
            // shows while the fetch is still out — a lie on web, where it can
            // take a second.
            <WorkspaceListSkeleton />
          ) : projects.length === 0 ? (
            <div className="mx-4 mt-6 rounded-2xl border border-border/60 bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
              No projects yet.
            </div>
          ) : (
            projects.map((project) => (
              <ProjectItem
                key={project.id}
                project={project}
                onSelectWorkspace={handleSelectWorkspace}
                activeWorkspaceId={activeWorkspaceId}
                onAddWorkspace={handleOpenAddWorkspace}
                onOpenChannel={onOpenChannel}
                error={projectErrors[String(project.id)] ?? null}
                workspaceDiffStats={workspaceDiffStats}
                streamingCounts={streamingCounts}
                unseenCounts={unseenCounts}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {/* Bottom Actions */}
      <div
        className={cn(
          "px-3 pt-3 border-t border-border/60 space-y-0.5 shrink-0",
          __APP_TARGET__ === "web" ? "pb-12" : "pb-3"
        )}
      >
        <button
          className="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors text-left text-foreground/85 hover:bg-muted/60 hover:text-foreground"
          onClick={onOpenCanvas}
        >
          <Network className="h-4 w-4" />
          <FormattedMessage id="sidebar.workflow" defaultMessage="Workflow" />
        </button>
        <button
          className="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors text-left text-foreground/85 hover:bg-muted/60 hover:text-foreground"
          onClick={onOpenSkills}
        >
          <Sparkles className="h-4 w-4" />
          <FormattedMessage id="sidebar.skills" defaultMessage="Skills" />
        </button>
        <button
          className="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors text-left text-foreground/85 hover:bg-muted/60 hover:text-foreground"
          onClick={onOpenCronjobs}
        >
          <CalendarClock className="h-4 w-4" />
          <FormattedMessage id="sidebar.schedule" defaultMessage="Schedule" />
        </button>

        <div className="flex items-center gap-1 mt-1">
          <button
            data-testid="settings-button"
            className="flex-1 flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors text-left text-foreground/85 hover:bg-muted/60 hover:text-foreground"
            onClick={onOpenSettings}
          >
            <Settings className="h-4 w-4" />
            <FormattedMessage id="sidebar.settings" defaultMessage="Settings" />
          </button>
          <UpdateReadyPill />
          <button
            type="button"
            className="flex items-center justify-center h-9 w-9 rounded-lg transition-colors text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            onClick={() => openExternalUrl("https://github.com/Nickqiaoo/Operon")}
          >
            <span className="text-xs font-bold">?</span>
          </button>
        </div>
      </div>

      <NewWorkspaceDialog
        open={!!newWorkspaceProjectId}
        onOpenChange={(open) => !open && setNewWorkspaceProjectId(null)}
        project={projects.find(p => p.id === newWorkspaceProjectId) || null}
        onConfirm={handleConfirmAddWorkspace}
      />
    </div>
  )
}
