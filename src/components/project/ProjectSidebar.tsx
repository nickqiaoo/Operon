import { fileCitationsToText } from '@/lib/file-citation'
import { api } from "@/lib/api"
import { openExternalUrl } from "@/lib/open-external"
import { CalendarClock, CircleHelp, Folder, FolderOpen, GitBranch, Hash, Inbox, Plus, Settings, Package, Network, LayoutDashboard, MessageCircle, Pin, PinOff, type LucideIcon } from "lucide-react"
import { SpecIcon } from "@/components/icons/SpecIcon"
import { toast } from "sonner"
import { Fragment, memo, useCallback, useEffect, useId, useRef, useState, type ComponentProps } from "react"
import { useIntl } from "react-intl"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useProjectStore, Project, Workspace, WorkspaceTask, WorkspaceDiffStat } from "@/stores/project-store"
import { useWorkspaceDiffStats } from "@/hooks/useWorkspaceDiffStats"
import { useEditorStore } from "@/stores/editor-store"
import type { EditorTab } from "@/types/editor"
import { useStreamingStore } from "@/stores/streaming-store"
import { useInboxStore } from "@/stores/inbox-store"
import { useNavigationStore } from "@/stores/navigation-store"
import { trackEvent } from "@/lib/analytics"
import { UpdateReadyPill } from "@/components/update/UpdateReadyPill"
import { LEFT_SIDEBAR_DEFAULT_WIDTH } from "@/components/app-shell/constants"
import { InboxPanel } from "@/components/inbox/InboxPanel"
import type { Notification } from "@/types/notification"
import { NewWorkspaceDialog } from "./NewWorkspaceDialog"
import { useRailFlyout } from "./use-rail-flyout"
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

const ProjectItem = memo(function ProjectItem({
  project,
  onSelectWorkspace,
  activeWorkspaceId,
  onAddWorkspace,
  onTogglePin,
  error,
  workspaceDiffStats,
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
                  workspaceId={workspace.id}
                  label={workspace.name}
                  title={workspace.worktreePath}
                  isActive={activeWorkspaceId === workspace.id}
                  stats={workspaceDiffStats?.[workspace.worktreePath]}
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
})

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

const countChatTabs = (tabs: EditorTab[] | undefined, ids: Set<string>) =>
  tabs?.reduce((count, tab) => count + (tab.type === "chat" && ids.has(tab.id) ? 1 : 0), 0) ?? 0

/**
 * Streaming / unread chat counts for one workspace. Subscribed per row, as
 * numbers, so a turn starting or ending re-renders that row instead of the whole
 * sidebar (~12ms in dev, right as the reply finishes).
 */
function useWorkspaceChatActivity(workspaceId: number) {
  const tabs = useEditorStore((s) =>
    s.currentWorkspaceId === workspaceId ? s.tabs : s.workspaceStates[String(workspaceId)]?.tabs
  )
  const streaming = useStreamingStore((s) => countChatTabs(tabs, s.streamingTabIds))
  const unseen = useStreamingStore((s) => countChatTabs(tabs, s.unseenTabIds))
  return { streaming, unseen }
}

function WorkspaceRow({ workspaceId, label, title, isActive, stats, onSelect }: {
  workspaceId: number
  label: string
  title: string
  isActive: boolean
  stats?: WorkspaceDiffStat
  onSelect: () => void
}) {
  const { streaming, unseen } = useWorkspaceChatActivity(workspaceId)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isActive ? 'page' : undefined}
      title={title}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-lg py-1 pl-6 pr-3 text-left transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [@media(pointer:coarse)]:py-2',
        isActive && 'bg-row-selected hover:bg-row-selected',
        streaming > 0 && 'animate-shimmer-sweep',
      )}
    >
      <GitBranch className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={cn('min-w-0 flex-1 truncate text-sm', isActive ? 'font-semibold text-foreground' : 'font-medium text-foreground/70')}>{fileCitationsToText(label)}</span>
        {stats && (stats.additions > 0 || stats.deletions > 0) && (
          <span className="shrink-0 text-[11px] tabular-nums opacity-80">
            {stats.additions > 0 && <span className="text-diff-add">+{stats.additions}</span>}
            {stats.deletions > 0 && <span className="ml-0.5 text-diff-remove">-{stats.deletions}</span>}
          </span>
        )}
        {streaming + unseen > 0 && <span className="shrink-0 text-[11px] tabular-nums text-status-info">{streaming + unseen}</span>}
      </span>
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

/**
 * Where the sidebar sends you is read from and written to the navigation store
 * directly; only opening a Spec goes through `App`, which also has to keep that
 * Spec's conversation mounted.
 */
interface ProjectSidebarProps {
  onOpenSpec?: (taskId: number, projectId: number) => void
  /** Deep-link from a row in the rail's inbox flyout to its source. */
  onOpenNotification?: (notification: Notification) => void
  collapsed?: boolean
  width?: number
}

// Panels floating out of the collapsed rail share one placement and surface.
const railFlyoutClassName = "absolute bottom-2 left-[calc(100%+8px)] top-12 z-50 rounded-xl border border-border/60 bg-sidebar shadow-float"
const railFlyoutEnterClassName = "animate-in fade-in-0 slide-in-from-left-1 duration-150"
const RAIL_FLYOUT_MAX_WIDTH = "calc(100vw - 68px)"
// Inbox rows carry an icon, two lines of text and a timestamp column: at the
// project tree's 224px the text is left with about 100px.
const INBOX_FLYOUT_WIDTH = 340

/**
 * Runs the +N/-N refresh. Its own component because the hook subscribes to how
 * many chats are streaming: called in ProjectSidebar, every turn start and end
 * re-rendered the whole sidebar (~12ms in dev).
 */
function WorkspaceDiffStatsSync() {
  useWorkspaceDiffStats()
  return null
}

interface SidebarNavItemProps extends ComponentProps<"button"> {
  icon: LucideIcon
  label: string
  collapsed: boolean
  active?: boolean
  count?: number
  actionCount?: number
  tooltip?: boolean
  /** Off for buttons whose hover floats a panel: the tooltip then stays keyboard-only. */
  hoverTooltip?: boolean
}

// One rail/row slot: 40px tall, its 4px transparent border insetting the
// hover/selection fill to a 32px pill with an 8px radius.
const navItemClassName = (active: boolean | undefined) => cn(
  "relative flex h-10 w-full shrink-0 items-center gap-2 rounded-xl border-4 border-transparent bg-clip-padding px-1.5 text-left text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  active ? "bg-row-selected text-foreground hover:bg-row-selected" : "text-foreground/85 hover:bg-row-hover hover:text-foreground",
)

function SidebarNavItem({ icon: Icon, label, collapsed, active, count = 0, actionCount = 0, tooltip = true, hoverTooltip = true, className, ...props }: SidebarNavItemProps) {
  const total = actionCount || count
  const [tooltipOpen, setTooltipOpen] = useState(false)

  useEffect(() => {
    setTooltipOpen(false)
  }, [collapsed, tooltip])

  return (
    <Tooltip
      key={collapsed ? "icon" : "label"}
      delayDuration={600}
      open={collapsed && tooltip && tooltipOpen}
      onOpenChange={(open) => setTooltipOpen(collapsed && tooltip && open)}
    >
      <TooltipTrigger
        asChild
        onPointerMove={(event) => {
          // Radix skips its hover-to-open handler for a prevented event.
          if (!hoverTooltip) event.preventDefault()
        }}
        onFocus={(event) => {
          // Window activation restores focus without a previous DOM target.
          if (!event.relatedTarget) {
            event.preventDefault()
            setTooltipOpen(false)
          }
        }}
        onKeyUp={(event) => {
          if (event.key === "Tab") setTooltipOpen(collapsed && tooltip)
        }}
      >
        <button
          type="button"
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn(navItemClassName(active), className)}
          {...props}
        >
          <Icon className="size-5 shrink-0" />
          {/* Clipped, not ellipsized: while the sidebar closes the row narrows with
              its edge and the label fades out; "Assist…" would flash meanwhile. */}
          {!collapsed && <span className="sidebar-label-fade min-w-0 flex-1 overflow-hidden whitespace-nowrap">{label}</span>}
          {total > 0 && (
            <span className={cn(
              "shrink-0 text-[10px] font-medium tabular-nums",
              actionCount > 0 ? "rounded-full bg-accent-warm px-1 text-white" : "text-tint",
              collapsed ? "absolute -right-0.5 top-0 min-w-3 text-center animate-in fade-in duration-150" : "sidebar-label-fade px-1",
            )}>
              {total > 99 ? "99+" : total}
            </span>
          )}
        </button>
      </TooltipTrigger>
      {collapsed && tooltip && <TooltipContent side="right">{label}</TooltipContent>}
    </Tooltip>
  )
}

export function ProjectSidebar({ onOpenSpec, onOpenNotification, collapsed = false, width = LEFT_SIDEBAR_DEFAULT_WIDTH }: ProjectSidebarProps) {
  const intl = useIntl()
  const projectsLabel = intl.formatMessage({ id: "sidebar.projects", defaultMessage: "Projects" })
  const inboxLabel = intl.formatMessage({ id: "sidebar.inbox", defaultMessage: "Inbox" })
  const addRepositoryLabel = intl.formatMessage({ id: "sidebar.addRepository", defaultMessage: "Add repository" })
  const mainView = useNavigationStore((s) => s.main)
  const showMain = useNavigationStore((s) => s.showMain)
  const showWorkbench = useNavigationStore((s) => s.showWorkbench)
  const openPage = useNavigationStore((s) => s.openPage)
  const assistantActive = mainView.kind === "assistant"
  const inboxActive = mainView.kind === "inbox"
  const boardActive = mainView.kind === "board" && mainView.view === "board"
  const channelsActive = mainView.kind === "board" && mainView.view === "channels"
  const activeSpecId = mainView.kind === "spec" ? mainView.taskId : null
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

  const clearUnseen = useStreamingStore((s) => s.clearUnseen)
  const inboxAction = useInboxStore((s) => s.counts.action)
  const inboxTotal = useInboxStore((s) => s.counts.total)
  const assistantAction = useInboxStore((s) => s.counts.assistantAction ?? 0)
  const assistantTotal = useInboxStore((s) => s.counts.assistantTotal ?? 0)

  const [newWorkspaceProjectId, setNewWorkspaceProjectId] = useState<number | null>(null)
  const projectsTriggerRef = useRef<HTMLButtonElement>(null)
  const projectTreeRef = useRef<HTMLDivElement>(null)
  const inboxFlyoutRef = useRef<HTMLDivElement>(null)
  const projectTreeId = useId()
  const { flyout, close: closeFlyout, pin: pinFlyout, holdOpen: holdFlyoutOpen, triggerHover, panelHover } = useRailFlyout()
  const flyoutOpen = collapsed && flyout !== null
  const flyoutPinned = flyoutOpen && flyout.pinned
  const floating = collapsed && flyout?.kind === "projects"
  const inboxFloating = collapsed && flyout?.kind === "inbox"

  const closePreview = useCallback(() => {
    closeFlyout()
    // The tree is about to go inert, so hand focus back rather than drop it. Only
    // if it is in there: a hover-opened panel must not pull focus from the
    // composer. The trigger is mounted only in rail mode. Keep this callback
    // stable so expanding the sidebar does not invalidate the memoized rows.
    if (projectTreeRef.current?.contains(document.activeElement)) {
      projectsTriggerRef.current?.focus({ preventScroll: true })
    }
  }, [closeFlyout])

  useEffect(() => {
    if (!collapsed) closeFlyout()
  }, [collapsed, closeFlyout])

  useEffect(() => {
    if (!flyoutOpen || newWorkspaceProjectId !== null) return
    const tree = projectTreeRef.current
    const trigger = projectsTriggerRef.current
    const inbox = inboxFlyoutRef.current
    const isInside = (target: EventTarget | null) => target instanceof Node &&
      (tree?.contains(target) || trigger?.contains(target) || inbox?.contains(target))
    const dismissOutside = (event: Event) => {
      if (!isInside(event.target)) closeFlyout()
    }
    const dismissEscape = (event: KeyboardEvent) => {
      // Let an inner menu or dialog consume Escape first.
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      closePreview()
    }
    if (flyoutPinned) {
      // Focus the current item without moving the saved scroll position.
      const focusTarget = tree?.querySelector<HTMLElement>('[aria-current="page"]') ?? tree
      focusTarget?.focus({ preventScroll: true })
      document.addEventListener("focusin", dismissOutside)
    }
    document.addEventListener("pointerdown", dismissOutside)
    window.addEventListener("keydown", dismissEscape)
    return () => {
      document.removeEventListener("pointerdown", dismissOutside)
      document.removeEventListener("focusin", dismissOutside)
      window.removeEventListener("keydown", dismissEscape)
    }
  }, [flyoutOpen, flyoutPinned, closeFlyout, closePreview, newWorkspaceProjectId])

  const handleOpenNotification = (notification: Notification) => {
    if (notification.readAt == null) void useInboxStore.getState().markRead([notification.id])
    onOpenNotification?.(notification)
    closeFlyout()
  }

  const handleOpenSpec = useCallback((taskId: number, projectId: number) => {
    onOpenSpec?.(taskId, projectId)
    closePreview()
  }, [onOpenSpec, closePreview])

  // Clear unseen when user switches to a workspace. Tabs are read at click time
  // rather than subscribed: they change on every send (chat id, title, draft),
  // and subscribing re-rendered the whole sidebar each time (~12ms in dev).
  const handleSelectWorkspace = useCallback((workspaceId: number, projectId: number) => {
    const { currentWorkspaceId, tabs: currentTabs, workspaceStates } = useEditorStore.getState()
    const tabs = workspaceId === currentWorkspaceId ? currentTabs : (workspaceStates[String(workspaceId)]?.tabs ?? [])
    const chatTabIds = tabs.filter((t) => t.type === "chat").map((t) => t.id)
    if (chatTabIds.length > 0) clearUnseen(chatTabIds)
    setActiveWorkspace(workspaceId, projectId)
    // Picking a workspace leaves the Assistant / Inbox / Board view.
    showWorkbench()
    closePreview()
  }, [clearUnseen, setActiveWorkspace, showWorkbench, closePreview])

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

  const handleOpenAddWorkspace = useCallback((project: Project) => {
    // The dialog takes the pointer away; leaving must not close the panel behind it.
    holdFlyoutOpen()
    setNewWorkspaceProjectId(project.id)
  }, [holdFlyoutOpen])

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

  // The root follows the animated sidebar width, so the nav rows' hover and
  // selection pills narrow with the edge into the rail's 32px ones instead of
  // being cut off square. The project tree keeps the full width (below) and is
  // clipped instead: reflowing it every frame would cost a layout.
  return (
    <div className="relative flex h-full w-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <WorkspaceDiffStatsSync />
      {/* Titlebar cell. Canvas-coloured under a sidebar-coloured layer that
          fades with the labels: expanded it is the sidebar's grey top, while
          the rail (narrower than the traffic lights + toggle) leaves the
          titlebar one white band across the window. Same /50 line as the
          titlebars beside it, so the two meet as one. */}
      <div className="drag-region relative h-10 shrink-0 border-b border-border/50 bg-background">
        <div className="sidebar-label-fade pointer-events-none absolute inset-0 bg-sidebar" />
      </div>

      {/* Global destinations keep their labels when expanded and become a rail when collapsed. */}
      <nav aria-label="Workspace navigation" className="relative shrink-0 space-y-1 px-1.5">
        {/* The rail's Projects button exists only once the sidebar has finished
            collapsing. Until then this stand-in sits in its slot (just below the
            nav) and fades in as the labels fade out, so the real one replaces it
            without a pop. First child, so space-y doesn't add a margin under
            Channels. */}
        {!collapsed && (
          <div aria-hidden="true"
            className={cn(navItemClassName(mainView.kind === "workbench" || mainView.kind === "spec"),
              "sidebar-rail-fade pointer-events-none absolute left-1.5 top-full mt-1 w-10")}>
            <Folder className="size-5 shrink-0" />
          </div>
        )}
        <SidebarNavItem icon={MessageCircle} label={intl.formatMessage({ id: "sidebar.assistant", defaultMessage: "Assistant" })} collapsed={collapsed} active={assistantActive}
          count={assistantTotal} actionCount={assistantAction}
          onClick={() => { closeFlyout(); showMain({ kind: "assistant" }) }} />
        {/* While the inbox page is showing, a flyout would only repeat it. */}
        <SidebarNavItem icon={Inbox} label={inboxLabel} collapsed={collapsed} active={inboxActive}
          count={inboxTotal} actionCount={inboxAction} tooltip={!inboxFloating} hoverTooltip={inboxActive}
          {...(collapsed && !inboxActive ? triggerHover("inbox") : undefined)}
          onClick={() => { closeFlyout(); showMain({ kind: "inbox" }); trackEvent("page_opened", { page: "inbox" }) }} />
        <SidebarNavItem icon={LayoutDashboard} label={intl.formatMessage({ id: "sidebar.board", defaultMessage: "Board" })} collapsed={collapsed} active={boardActive}
          onClick={() => { closeFlyout(); showMain({ kind: "board", view: "board" }); trackEvent("page_opened", { page: "board" }) }} />
        <SidebarNavItem icon={Hash} label={intl.formatMessage({ id: "sidebar.channels", defaultMessage: "Channels" })} collapsed={collapsed} active={channelsActive}
          onClick={() => { closeFlyout(); showMain({ kind: "board", view: "channels" }); trackEvent("page_opened", { page: "channels" }) }} />
        {collapsed && (
          <SidebarNavItem ref={projectsTriggerRef} icon={Folder} label={projectsLabel} collapsed
            active={mainView.kind === "workbench" || mainView.kind === "spec"}
            aria-expanded={floating} aria-controls={projectTreeId} aria-haspopup="dialog" tooltip={!floating} hoverTooltip={false}
            {...triggerHover("projects")}
            // A click landing just after the hover delay must not close what
            // just opened, so it pins; only a pinned panel toggles shut.
            onClick={() => { if (floating && flyoutPinned) closeFlyout(); else pinFlyout("projects") }} />
        )}
      </nav>

      {inboxFloating && (
        <div
          ref={inboxFlyoutRef}
          data-testid="inbox-flyout"
          role="region"
          aria-label={inboxLabel}
          className={cn(railFlyoutClassName, railFlyoutEnterClassName, "overflow-hidden")}
          style={{ width: INBOX_FLYOUT_WIDTH, maxWidth: RAIL_FLYOUT_MAX_WIDTH }}
          {...panelHover}
        >
          <InboxPanel onItemClick={handleOpenNotification} />
        </div>
      )}

      {/* One mounted tree: changing its placement preserves scroll and project state. */}
      <div
        ref={projectTreeRef}
        id={projectTreeId}
        data-testid="project-tree"
        role={collapsed ? "dialog" : "region"}
        aria-label={projectsLabel}
        aria-hidden={collapsed && !floating}
        inert={collapsed && !floating}
        tabIndex={-1}
        className={cn(
          "flex min-h-0 flex-col outline-none",
          collapsed
            ? cn(railFlyoutClassName, "py-2")
            : "sidebar-label-fade flex-1 shrink-0",
          collapsed && !floating && "invisible pointer-events-none opacity-0",
          floating && railFlyoutEnterClassName,
        )}
        style={collapsed ? { width, maxWidth: RAIL_FLYOUT_MAX_WIDTH } : { width }}
        {...panelHover}
      >
        {/* Secondary Header */}
        <div className="h-9 px-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 heading-section">
            <span>{projectsLabel}</span>
          </div>
          {canAddProject && (
            <Button
              variant="ghost"
              size="icon"
              className="mr-2 h-6 w-6 rounded-md text-muted-foreground hover:text-foreground"
              onClick={handleAddProject}
              title={addRepositoryLabel}
              aria-label={addRepositoryLabel}
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
                    activeSpecId={activeSpecId}
                    onOpenSpec={handleOpenSpec}
                  />
                </Fragment>
              ))
            )}
          </div>
        </ScrollArea>
      </div>
      {collapsed && <div className="min-h-0 flex-1" />}

      {/* Keep every bottom destination directly accessible in both modes. */}
      <nav
        aria-label="Tools and settings"
        className={cn("relative shrink-0 space-y-1 border-t border-border/40 px-1.5 pt-2", __APP_TARGET__ === "web" ? "pb-12" : "pb-3")}
      >
        {/* The rail shows a pending update above this group. Always mounted in
            its slot, out of the layout: expanded it fades out with the labels
            (the row one beside Settings takes over), so the mode switch never
            moves or remounts it. First child: see the Projects stand-in. */}
        <div
          className={cn("absolute bottom-full left-1.5 mb-1 w-10", !collapsed && "sidebar-rail-fade pointer-events-none")}
          inert={!collapsed}
          aria-hidden={!collapsed || undefined}
        >
          <UpdateReadyPill variant="rail" />
        </div>
        <SidebarNavItem icon={Network} label={intl.formatMessage({ id: "sidebar.workflow", defaultMessage: "Workflow" })} collapsed={collapsed} onClick={() => openPage({ kind: "canvas" })} />
        <SidebarNavItem icon={Package} label={intl.formatMessage({ id: "sidebar.plugins", defaultMessage: "Plugins" })} collapsed={collapsed} onClick={() => openPage({ kind: "plugins" })} />
        <SidebarNavItem icon={CalendarClock} label={intl.formatMessage({ id: "sidebar.schedule", defaultMessage: "Schedule" })} collapsed={collapsed} onClick={() => openPage({ kind: "schedule" })} />
        <div className="flex items-center gap-0.5">
          <SidebarNavItem icon={Settings} label={intl.formatMessage({ id: "sidebar.settings", defaultMessage: "Settings" })} collapsed={collapsed} data-testid="settings-button"
            // min-w-10: while the sidebar closes, Help and the update button
            // overflow past the edge (and are clipped) rather than squeeze this.
            className={cn("min-w-10", !collapsed && "flex-1")} onClick={() => openPage({ kind: "settings" })} />
          {!collapsed && <UpdateReadyPill className="sidebar-label-fade" />}
          {!collapsed && (
            <Tooltip delayDuration={600}>
              <TooltipTrigger asChild onFocus={(event) => {
                if (!event.relatedTarget) event.preventDefault()
              }}>
                <button type="button" aria-label={intl.formatMessage({ id: "sidebar.help", defaultMessage: "Help" })}
                  className="sidebar-label-fade flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent-hover hover:text-foreground active:bg-accent-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => openExternalUrl("https://github.com/Nickqiaoo/Operon")}>
                  <CircleHelp className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{intl.formatMessage({ id: "sidebar.help", defaultMessage: "Help" })}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </nav>

      <NewWorkspaceDialog
        open={!!newWorkspaceProjectId}
        onOpenChange={(open) => !open && setNewWorkspaceProjectId(null)}
        project={projects.find(p => p.id === newWorkspaceProjectId) || null}
        onConfirm={handleConfirmAddWorkspace}
      />
    </div>
  )
}
