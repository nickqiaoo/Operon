import { fileCitationsToText } from '@/lib/file-citation'
import { api } from "@/lib/api"
import { openExternalUrl } from "@/lib/open-external"
import { CalendarClock, CircleHelp, Folder, FolderOpen, GitBranch, Hash, Inbox, Plus, Settings, Package, Network, LayoutDashboard, PanelLeft, MessageCircle, Pin, PinOff } from "lucide-react"
import { SpecIcon } from "@/components/icons/SpecIcon"
import { toast } from "sonner"
import { Fragment, useCallback, useMemo, useState } from "react"
import { useIntl, FormattedMessage } from "react-intl"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useProjectStore, Project, Workspace, WorkspaceTask, WorkspaceDiffStat } from "@/stores/project-store"
import { useEditorStore } from "@/stores/editor-store"
import type { EditorTab } from "@/types/editor"
import { useStreamingStore } from "@/stores/streaming-store"
import { useInboxStore } from "@/stores/inbox-store"
import { UpdateReadyPill } from "@/components/update/UpdateReadyPill"
import { NewWorkspaceDialog } from "./NewWorkspaceDialog"
import { projectSidebarEntries } from "./workspace-groups"

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
  onTogglePin: (project: Project) => void
  error?: string | null
  workspaceDiffStats?: Record<string, WorkspaceDiffStat>
  streamingCounts?: Record<number, number>
  unseenCounts?: Record<number, number>
  activeSpecId?: number | null
  onOpenSpec?: (taskId: number, projectId: number) => void
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

const trimSlash = (p: string) => p.replace(/[\\/]+$/, "")

const isMainCheckout = (workspace: Workspace, project: Project) =>
  trimSlash(workspace.worktreePath) === trimSlash(project.rootPath)

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
  onTogglePin,
  error,
  workspaceDiffStats,
  streamingCounts,
  unseenCounts,
  activeSpecId,
  onOpenSpec,
}: ProjectItemProps) {
  const pinned = project.pinnedAt != null
  const collapsed = useProjectStore((s) => s.collapsedProjectIds.includes(project.id))
  const ProjectIcon = collapsed ? Folder : FolderOpen
  const setProjectCollapsed = useProjectStore((s) => s.setProjectCollapsed)
  const containsActiveWorkspace = project.workspaces.some((workspace) => workspace.id === activeWorkspaceId) || project.specs?.some((spec) => spec.id === activeSpecId) || project.workspaces.some((workspace) => workspace.task?.id === activeSpecId)
  const pinLabel = pinned ? "Unpin" : "Pin to top"
  const hiddenSpecIds = useProjectStore((s) => s.hiddenSpecIds)
  const shownSpecIds = useProjectStore((s) => s.shownSpecIds)
  const entries = projectSidebarEntries(project, shownSpecIds, hiddenSpecIds)
  return (
    <Collapsible
      open={!collapsed}
      onOpenChange={(open) => setProjectCollapsed(project.id, !open)}
      className="px-4"
    >
      <div className={cn(
        "group/project-header relative mb-0.5 flex items-center gap-1 rounded-lg text-sm font-medium text-foreground/80 transition-colors hover:bg-row-hover",
        collapsed && containsActiveWorkspace && "bg-row-selected text-foreground hover:bg-row-selected"
      )}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-1 pl-1 text-left [@media(pointer:coarse)]:py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${project.name}`}
            title={project.name}
          >
            <ProjectIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                // Reserve room for the actions only while they are visible.
                "pr-0 group-hover/project-header:pr-[58px] group-has-[:focus-visible]/project-header:pr-[58px] [@media(hover:none)]:pr-[58px]"
              )}
            >
              {project.name}
            </span>
          </button>
        </CollapsibleTrigger>
        {/* Reveal actions on hover or keyboard focus without covering the name. */}
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-4">
          <div
            className={cn(
              "absolute right-[9px] top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity",
              "group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100",
              "group-has-[:focus-visible]/project-header:pointer-events-auto group-has-[:focus-visible]/project-header:opacity-100",
              // Touch screens have no hover to reveal them, so they sit in flow.
              "[@media(hover:none)]:static [@media(hover:none)]:translate-y-0 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
            )}>
            <Button
              variant="ghost"
              size="icon"
              className="size-5 rounded-md bg-transparent text-muted-foreground hover:bg-accent-hover hover:text-foreground"
              onClick={() => onTogglePin(project)}
              title={pinLabel}
              aria-label={`${pinLabel} ${project.name}`}
            >
              {pinned ? (
                <PinOff className="size-3.5" strokeWidth={1.5} />
              ) : (
                <Pin className="size-3.5" strokeWidth={1.5} />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-5 rounded-md bg-transparent text-muted-foreground hover:bg-accent-hover hover:text-foreground"
              onClick={() => onAddWorkspace(project)}
              title="New workspace on a new branch"
              aria-label={`New workspace in ${project.name}`}
            >
              <Plus className="size-3.5" strokeWidth={1.5} />
            </Button>
          </div>
        </div>
      </div>
      {error && (
        <div className="mb-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <CollapsibleContent>
        {entries.workspaces.length > 0 && (
          <div className="pb-1">
            {[...entries.workspaces]
              .sort((a, b) => Number(isMainCheckout(b, project)) - Number(isMainCheckout(a, project)))
              .map((workspace) => (
                <WorkspaceRow
                  key={workspace.id}
                  label={workspace.name}
                  title={workspace.worktreePath}
                  isActive={activeWorkspaceId === workspace.id}
                  stats={workspaceDiffStats?.[workspace.worktreePath]}
                  streaming={streamingCounts?.[workspace.id] ?? 0}
                  unseen={unseenCounts?.[workspace.id] ?? 0}
                  onSelect={() => onSelectWorkspace(workspace.id, project.id)}
                />
              ))}
          </div>
        )}
        {entries.specs.length > 0 && (
          <div className="pb-1">
            {entries.specs.map((spec) => (
              <SpecRow key={spec.id} spec={spec} active={activeSpecId === spec.id} onSelect={() => onOpenSpec?.(spec.id, project.id)} />
            ))}
          </div>
        )}
        {entries.workspaces.length === 0 && entries.specs.length === 0 && (
          <div className="px-6 py-3 text-xs text-muted-foreground">No workspaces yet.</div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function SpecRow({ spec, active, onSelect }: { spec: WorkspaceTask; active: boolean; onSelect: () => void }) {
  const needsInput = ['awaiting_answers', 'awaiting_design', 'awaiting_signoff'].includes(spec.specStage ?? '')
  const running = ['grounding', 'designing', 'building', 'reviewing', 'integrating'].includes(spec.specStage ?? '')
  const status = spec.specStage === 'awaiting_answers' ? 'Needs input' : needsInput ? 'Needs review' : running ? 'Running' : spec.specStage === 'done' ? 'Done' : spec.specStage === 'failed' ? 'Failed' : 'Stopped'
  return (
    <button
      type="button"
      data-testid={`sidebar-spec-${spec.id}`}
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
      title={`Spec #${spec.number} · ${spec.title} · ${status}`}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-lg py-1 pl-6 pr-3 text-left transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [@media(pointer:coarse)]:py-2',
        active && 'bg-row-selected hover:bg-row-selected',
      )}
    >
      <SpecIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      <span className={cn('min-w-0 flex-1 truncate text-sm', active ? 'font-semibold text-foreground' : 'font-medium text-foreground/70')}>{fileCitationsToText(spec.title)}</span>
      <span className={cn('shrink-0 text-[10px]', needsInput ? 'text-status-warn' : 'text-muted-foreground')}>{status}</span>
    </button>
  )
}

function WorkspaceRow({ label, title, isActive, stats, streaming, unseen, onSelect }: {
  label: string
  title: string
  isActive: boolean
  stats?: WorkspaceDiffStat
  streaming: number
  unseen: number
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isActive ? 'page' : undefined}
      title={title}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-lg py-1 pl-6 pr-3 text-left transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [@media(pointer:coarse)]:py-2',
        isActive && 'bg-row-selected hover:bg-row-selected',
        isActive && streaming > 0 && 'animate-shimmer-sweep',
      )}
    >
      <GitBranch className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      <span className={cn('min-w-0 flex-1 truncate text-sm', isActive ? 'font-semibold text-foreground' : 'font-medium text-foreground/70')}>{fileCitationsToText(label)}</span>
      {stats && (stats.additions > 0 || stats.deletions > 0) && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums opacity-80">
          {stats.additions > 0 && <span className="text-diff-add">+{stats.additions}</span>}
          {stats.deletions > 0 && <span className="ml-0.5 text-diff-remove">-{stats.deletions}</span>}
        </span>
      )}
      {streaming + unseen > 0 && <span className="shrink-0 text-[11px] tabular-nums text-status-info">{streaming + unseen}</span>}
    </button>
  )
}

/** Placeholder tree while the first `loadProjects` is in flight. */
function WorkspaceListSkeleton() {
  return (
    <div className="px-4" aria-hidden>
      {[3, 2].map((workspaceCount, projectIndex) => (
        <div key={projectIndex} className="pb-3" style={{ opacity: 1 - projectIndex * 0.35 }}>
          <div className="flex items-center gap-2 pb-1">
            <Skeleton className="size-4 shrink-0 rounded" />
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
  onOpenPlugins: () => void
  onOpenCanvas: () => void
  /** The board and channels across every project (one page, two views). */
  onOpenBoard?: () => void
  onOpenChannels?: () => void
  onOpenInbox?: () => void
  onOpenAssistant?: () => void
  /** The Assistant view is showing in place of the editor. */
  assistantActive?: boolean
  /** The Inbox is showing in place of the editor. */
  inboxActive?: boolean
  /** The Board / Channels is showing in place of the editor. */
  boardActive?: boolean
  channelsActive?: boolean
  /** Picking a workspace leaves the Assistant / Inbox view. */
  onLeaveMainView?: () => void
  activeSpecId?: number | null
  onOpenSpec?: (taskId: number, projectId: number) => void
  onCollapse?: () => void
  collapsed?: boolean
}

export function ProjectSidebar({ onOpenSettings, onOpenCronjobs, onOpenPlugins, onOpenCanvas, onOpenBoard, onOpenChannels, onOpenInbox, onOpenAssistant, assistantActive, inboxActive, boardActive, channelsActive, onLeaveMainView, activeSpecId, onOpenSpec, onCollapse, collapsed }: ProjectSidebarProps) {
  const intl = useIntl()
  const canAddProject = __APP_TARGET__ !== "web"
  const projects = useProjectStore((s) => s.projects)
  const projectsLoaded = useProjectStore((s) => s.projectsLoaded)
  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)
  const addProject = useProjectStore((s) => s.addProject)
  const addWorkspace = useProjectStore((s) => s.addWorkspace)
  const setActiveWorkspace = useProjectStore((s) => s.setActiveWorkspace)
  const setProjectWorkspaces = useProjectStore((s) => s.setProjectWorkspaces)
  const setProjectPinned = useProjectStore((s) => s.setProjectPinned)
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
    onLeaveMainView?.()
  }, [getWorkspaceTabs, clearUnseen, setActiveWorkspace, onLeaveMainView])

  const handleTogglePin = useCallback((project: Project) => {
    void setProjectPinned(project.id, project.pinnedAt == null).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error))
    })
  }, [setProjectPinned])

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
            className="no-drag flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-accent-hover hover:text-foreground transition-colors"
            style={{ viewTransitionName: "sidebar-trigger" }}
            onClick={onCollapse}
            title={intl.formatMessage({ id: "sidebar.collapse", defaultMessage: "Collapse sidebar" })}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Global destinations */}
      {(onOpenAssistant || onOpenInbox || onOpenBoard || onOpenChannels) && (
        <div className="px-2 pt-2 shrink-0">
          {onOpenAssistant && (
            <button
              type="button"
              onClick={onOpenAssistant}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-2 text-sm font-medium rounded-lg transition-colors text-left",
                // Same selection fill as a workspace row, so the two read as one kind of "you are here".
                assistantActive
                  ? "bg-row-selected text-foreground hover:bg-row-selected"
                  : "text-foreground/85 hover:bg-row-hover hover:text-foreground",
              )}
            >
              <MessageCircle className="h-4 w-4" />
              <span className="flex-1"><FormattedMessage id="sidebar.assistant" defaultMessage="Assistant" /></span>
            </button>
          )}
          {onOpenInbox && (
          <button
            type="button"
            onClick={onOpenInbox}
            className={cn(
              "w-full flex items-center gap-2 px-2 py-2 text-sm font-medium rounded-lg transition-colors text-left",
              inboxActive
                ? "bg-row-selected text-foreground hover:bg-row-selected"
                : "text-foreground/85 hover:bg-row-hover hover:text-foreground",
            )}
          >
            <Inbox className="h-4 w-4" />
            <span className="flex-1"><FormattedMessage id="sidebar.inbox" defaultMessage="Inbox" /></span>
            {inboxAction > 0 ? (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-warm px-1 text-[10px] font-medium leading-none text-white">
                {inboxAction > 99 ? "99+" : inboxAction}
              </span>
            ) : inboxTotal > 0 ? (
              <span className="px-1 text-xs font-semibold leading-none text-tint tabular-nums">
                {inboxTotal > 99 ? "99+" : inboxTotal}
              </span>
            ) : null}
          </button>
          )}
          {onOpenBoard && (
            <button
              type="button"
              onClick={onOpenBoard}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-2 text-sm font-medium rounded-lg transition-colors text-left",
                boardActive
                  ? "bg-row-selected text-foreground hover:bg-row-selected"
                  : "text-foreground/85 hover:bg-row-hover hover:text-foreground",
              )}
            >
              <LayoutDashboard className="h-4 w-4" />
              <span className="flex-1"><FormattedMessage id="sidebar.board" defaultMessage="Board" /></span>
            </button>
          )}
          {onOpenChannels && (
            <button
              type="button"
              onClick={onOpenChannels}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-2 text-sm font-medium rounded-lg transition-colors text-left",
                channelsActive
                  ? "bg-row-selected text-foreground hover:bg-row-selected"
                  : "text-foreground/85 hover:bg-row-hover hover:text-foreground",
              )}
            >
              <Hash className="h-4 w-4" />
              <span className="flex-1"><FormattedMessage id="sidebar.channels" defaultMessage="Channels" /></span>
            </button>
          )}
        </div>
      )}

      {/* Secondary Header */}
      <div className="h-9 px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 heading-section">
          <span>Projects</span>
        </div>
        {canAddProject && (
          <Button
            variant="ghost"
            size="icon"
            className="mr-2 h-6 w-6 rounded-md text-muted-foreground hover:text-foreground"
            onClick={handleAddProject}
            title={intl.formatMessage({ id: "sidebar.addRepository", defaultMessage: "Add repository" })}
            aria-label={intl.formatMessage({ id: "sidebar.addRepository", defaultMessage: "Add repository" })}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>
      <ScrollArea className="flex-1 min-h-0 [&>[data-slot=scroll-area-viewport]>div]:!block [&>[data-slot=scroll-area-viewport]>div]:!min-w-0" viewportClassName="scroll-fade-y [--scroll-fade-gutter:0px]">
        <div className="space-y-0.5 pb-3 pt-0">
          {projects.length === 0 && !projectsLoaded ? (
            // First load with nothing cached. Without this the empty state
            // shows while the fetch is still out — a lie on web, where it can
            // take a second.
            <WorkspaceListSkeleton />
          ) : projects.length === 0 ? (
            <div className="mx-4 mt-6 rounded-xl border border-border/60 bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
              No projects yet.
            </div>
          ) : (
            projects.map((project, i) => (
              <Fragment key={project.id}>
                {/* A hairline where the pinned ones end. */}
                {i > 0 && projects[i - 1].pinnedAt != null && project.pinnedAt == null && (
                  <div className="mx-4 my-1 border-t border-border/40" />
                )}
                <ProjectItem
                  project={project}
                  onSelectWorkspace={handleSelectWorkspace}
                  // Only one place is "current": while the Assistant is showing, no workspace is.
                  activeWorkspaceId={assistantActive || inboxActive || boardActive || channelsActive || activeSpecId != null ? null : activeWorkspaceId}
                  onAddWorkspace={handleOpenAddWorkspace}
                  onTogglePin={handleTogglePin}
                  error={projectErrors[String(project.id)] ?? null}
                  workspaceDiffStats={workspaceDiffStats}
                  streamingCounts={streamingCounts}
                  unseenCounts={unseenCounts}
                  activeSpecId={activeSpecId}
                  onOpenSpec={onOpenSpec}
                />
              </Fragment>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Bottom Actions */}
      <div
        className={cn(
          "px-3 pt-3 border-t border-border/40 dark:border-border/35 space-y-0.5 shrink-0",
          __APP_TARGET__ === "web" ? "pb-12" : "pb-3"
        )}
      >
        <button
          className="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors text-left text-foreground/85 hover:bg-row-hover hover:text-foreground"
          onClick={onOpenCanvas}
        >
          <Network className="h-4 w-4" />
          <FormattedMessage id="sidebar.workflow" defaultMessage="Workflow" />
        </button>
        <button
          className="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors text-left text-foreground/85 hover:bg-row-hover hover:text-foreground"
          onClick={onOpenPlugins}
        >
          <Package className="h-4 w-4" />
          <FormattedMessage id="sidebar.plugins" defaultMessage="Plugins" />
        </button>
        <button
          className="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors text-left text-foreground/85 hover:bg-row-hover hover:text-foreground"
          onClick={onOpenCronjobs}
        >
          <CalendarClock className="h-4 w-4" />
          <FormattedMessage id="sidebar.schedule" defaultMessage="Schedule" />
        </button>

        <div className="flex items-center gap-1 mt-1">
          <button
            data-testid="settings-button"
            className="flex-1 flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors text-left text-foreground/85 hover:bg-row-hover hover:text-foreground"
            onClick={onOpenSettings}
          >
            <Settings className="h-4 w-4" />
            <FormattedMessage id="sidebar.settings" defaultMessage="Settings" />
          </button>
          <UpdateReadyPill />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={intl.formatMessage({ id: "sidebar.help", defaultMessage: "Help" })}
                className="flex items-center justify-center h-9 w-9 shrink-0 rounded-lg transition-colors text-muted-foreground hover:bg-accent-hover hover:text-foreground active:bg-accent-active"
                onClick={() => openExternalUrl("https://github.com/Nickqiaoo/Operon")}
              >
                <CircleHelp className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <FormattedMessage id="sidebar.help" defaultMessage="Help" />
            </TooltipContent>
          </Tooltip>
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
