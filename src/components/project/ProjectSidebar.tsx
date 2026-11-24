import { fileCitationsToText } from '@/lib/file-citation'
import { api } from "@/lib/api"
import { attentionOf, hasUnread, useChannelUnreadMap } from "@/lib/channel-queries"
import { CalendarClock, ChevronRight, Folder, FolderOpen, GitBranch, Hash, ListFilter, Plus, Settings, Package, Network, LayoutDashboard, MessageCircle, Pin, PinOff, SquarePen, type LucideIcon } from "lucide-react"
import { SpecIcon } from "@/components/icons/SpecIcon"
import { toast } from "sonner"
import { Fragment, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from "react"
import { useIntl } from "react-intl"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { projectsOn, useProjectStore, Project, Workspace, WorkspaceTask, WorkspaceDiffStat } from "@/stores/project-store"
import { useWorkspaceDiffStats } from "@/hooks/useWorkspaceDiffStats"
import { isWorkspaceView, useAppShellStore } from "@/stores/app-shell-store"
import { useEditorStore } from "@/stores/editor-store"
import type { EditorTab } from "@/types/editor"
import { useStreamingStore } from "@/stores/streaming-store"
import { useInboxStore } from "@/stores/inbox-store"
import { useNavigationStore } from "@/stores/navigation-store"
import { trackEvent } from "@/lib/analytics"
import { UpdateReadyPill } from "@/components/update/UpdateReadyPill"
import { AccountUsageRail } from "@/components/app-shell/AccountUsageRail"
import { MachineActionsContext, MachineSwitcher } from "@/components/web/MachineSwitcher"
import { LEFT_SIDEBAR_DEFAULT_WIDTH, LEFT_SIDEBAR_RAIL_WIDTH } from "@/components/app-shell/constants"
import { AgentIcon, FocusConversations, RecentConversations, useActiveAttentionCounts, useChatAttention } from "@/components/active/ActiveConversations"
import { chatIdOfTab, type ActiveGroup, type OpenChat } from "@/lib/active-conversations"
import { childCounts, type ChatChild, type ChildState } from "@/lib/chat-children"
import { openChildChat, useChatChildren, useTaskChildChatIds } from "@/hooks/useChatChildren"
import { isOnNode, useExternalAgentsStore } from "@/stores/external-agents-store"
import { useWorkspaceLatestChats, type ChatHistoryListItem } from "@/lib/chat-queries"
import { formatRelativeTime } from "@/lib/format"
import type { Notification } from "@/types/notification"
import { NewWorkspaceDialog } from "./NewWorkspaceDialog"
import { createProjectWorkspace } from "@/lib/workspace-actions"
import { startNewChat, startNewChatInWorkspace } from "@/lib/new-chat"
import { useRailFlyout } from "./use-rail-flyout"
import { ChannelList } from "@/components/channel/ChannelList"
import { projectSidebarEntries } from "./workspace-groups"
import { chatRefFromTabId, chatRefOf, chatRefOfTab, chatTabId, localChat, sameChat, sameNode, workspaceBucketKey } from "@/lib/chat-ref"
import { MachineHeader, RemoteMachineTrees, useOtherMachines, useThisMachineLabel } from "./RemoteMachineTrees"

type GitWorktreeEntry = {
  path: string
  branch: string | null
  head: string | null
  detached: boolean
}

interface ProjectItemProps {
  project: Project
  onSelectWorkspace: (workspaceId: number, projectId: number) => void
  onNewChatInWorkspace: (workspaceId: number, projectId: number) => void
  onOpenChat: OpenTreeChat
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
  onNewChatInWorkspace,
  onOpenChat,
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
      // An 8px inset, not 16: chat titles need the width more than the margin does.
      className="px-2"
    >
      <div className={cn(
        "group/project-header relative mb-0.5 flex items-center gap-1 rounded-lg text-sm font-medium text-foreground/80 transition-colors hover:bg-row-hover",
        collapsed && containsActiveWorkspace && "bg-row-selected text-foreground hover:bg-row-selected"
      )}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-1 pl-2 text-left [@media(pointer:coarse)]:py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
                <WorkspaceEntry
                  key={workspace.id}
                  workspace={workspace}
                  projectId={project.id}
                  isActive={activeWorkspaceId === workspace.id}
                  stats={workspaceDiffStats?.[workspace.worktreePath]}
                  onSelectWorkspace={onSelectWorkspace}
                  onNewChatInWorkspace={onNewChatInWorkspace}
                  onOpenChat={onOpenChat}
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

/**
 * One workspace row plus its conversations. It subscribes to its own folded
 * flag (a boolean), so folding one workspace re-renders just this entry rather
 * than every project in the tree.
 */
export const WorkspaceEntry = memo(function WorkspaceEntry({ workspace, projectId, nodeId, isActive, stats, onSelectWorkspace, onNewChatInWorkspace, onOpenChat }: {
  workspace: Workspace
  projectId: number
  /** The workspace's machine (undefined: this one). */
  nodeId?: string
  isActive: boolean
  stats?: WorkspaceDiffStat
  onSelectWorkspace: ProjectItemProps["onSelectWorkspace"]
  onNewChatInWorkspace: ProjectItemProps["onNewChatInWorkspace"]
  onOpenChat: ProjectItemProps["onOpenChat"]
}) {
  // Folding is persisted by workspace id, which is this machine's; another
  // machine's workspaces fold for the session only.
  const storedCollapsed = useProjectStore((s) => s.collapsedWorkspaceIds.includes(workspace.id))
  const setStoredCollapsed = useProjectStore((s) => s.setWorkspaceCollapsed)
  const [remoteCollapsed, setRemoteCollapsed] = useState(false)
  const collapsed = nodeId ? remoteCollapsed : storedCollapsed
  const setWorkspaceCollapsed = useCallback((id: number, value: boolean) => {
    if (nodeId) setRemoteCollapsed(value)
    else setStoredCollapsed(id, value)
  }, [nodeId, setStoredCollapsed])
  return (
    <>
      <WorkspaceRow
        workspaceId={workspace.id}
        nodeId={nodeId}
        label={workspace.name}
        title={workspace.worktreePath}
        isActive={isActive}
        expanded={!collapsed}
        stats={stats}
        onSelect={() => {
          // A click on the workspace you are in folds / unfolds its conversations;
          // on another one it goes there, unfolding it if it was folded.
          if (isActive) {
            setWorkspaceCollapsed(workspace.id, !collapsed)
            return
          }
          if (collapsed) setWorkspaceCollapsed(workspace.id, false)
          onSelectWorkspace(workspace.id, projectId)
        }}
        onNewChat={() => {
          // A new chat lands in this list, so show it.
          if (collapsed) setWorkspaceCollapsed(workspace.id, false)
          onNewChatInWorkspace(workspace.id, projectId)
        }}
      />
      {!collapsed && <WorkspaceChats workspaceId={workspace.id} nodeId={nodeId} onOpenChat={onOpenChat} />}
    </>
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
        'flex w-full min-w-0 items-center gap-2 rounded-lg py-1 pl-5 pr-3 text-left transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [@media(pointer:coarse)]:py-2',
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
function useWorkspaceChatActivity(workspaceId: number, nodeId?: string) {
  const tabs = useEditorStore((s) =>
    s.currentWorkspaceId === workspaceId && sameNode(s.currentNodeId, nodeId)
      ? s.tabs
      : s.workspaceStates[workspaceBucketKey(workspaceId, nodeId)]?.tabs
  )
  const streaming = useStreamingStore((s) => countChatTabs(tabs, s.streamingTabIds))
  const unseen = useStreamingStore((s) => countChatTabs(tabs, s.unseenTabIds))
  return { streaming, unseen }
}

function WorkspaceRow({ workspaceId, nodeId, label, title, isActive, expanded, stats, onSelect, onNewChat }: {
  workspaceId: number
  nodeId?: string
  label: string
  title: string
  isActive: boolean
  /** Whether its conversations are listed under it. */
  expanded: boolean
  stats?: WorkspaceDiffStat
  onSelect: () => void
  onNewChat: () => void
}) {
  const { streaming, unseen } = useWorkspaceChatActivity(workspaceId, nodeId)
  // A saved chat on screen is highlighted in its own row below; filling this
  // one too stacked two selected rows into one block. Bold is enough here.
  const chatOnScreen = useEditorStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.type === "chat" && chatIdOfTab(tab) != null
  })
  const filled = isActive && !chatOnScreen
  return (
    // The pen is a sibling of the row button (buttons can't nest), revealed on
    // hover / keyboard focus in the slot the diff stats and counts occupy.
    <div className="group/workspace-row relative">
    <button
      type="button"
      onClick={onSelect}
      aria-current={isActive ? 'page' : undefined}
      aria-expanded={expanded}
      data-testid={nodeId ? `workspace-row-${nodeId}-${workspaceId}` : `workspace-row-${workspaceId}`}
      title={title}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-lg py-1 pl-5 pr-3 text-left transition-colors hover:bg-row-hover group-hover/workspace-row:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [@media(pointer:coarse)]:py-2',
        filled && 'bg-row-selected hover:bg-row-selected group-hover/workspace-row:bg-row-selected',
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
        {/* Room for the pen while it shows, so it never covers the name. */}
        <span aria-hidden className="hidden w-5 shrink-0 group-hover/workspace-row:block group-has-[:focus-visible]/workspace-row:block [@media(hover:none)]:block" />
      </span>
    </button>
    <Button
      variant="ghost"
      size="icon"
      data-testid={nodeId ? `workspace-new-chat-${nodeId}-${workspaceId}` : `workspace-new-chat-${workspaceId}`}
      className={cn(
        "absolute right-2 top-1/2 size-5 -translate-y-1/2 rounded-md bg-transparent text-muted-foreground opacity-0 pointer-events-none transition-opacity hover:bg-accent-hover hover:text-foreground",
        "group-hover/workspace-row:pointer-events-auto group-hover/workspace-row:opacity-100",
        "focus-visible:pointer-events-auto focus-visible:opacity-100",
        "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
      )}
      onClick={onNewChat}
      title="New chat in this workspace"
      aria-label={`New chat in ${fileCitationsToText(label)}`}
    >
      <SquarePen className="size-3.5" strokeWidth={1.5} />
    </Button>
    </div>
  )
}

/** Open a conversation listed under a workspace in the tree. */
type OpenTreeChat = (chat: ChatHistoryListItem, workspaceId: number) => void

// One 12px step in from the workspace row (pl-5), as the workspace is from its project.
const treeRowClassName = "group/chat-row flex h-7 w-full min-w-0 items-center gap-2 rounded-lg pl-8 pr-2 text-left transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [@media(pointer:coarse)]:h-9"

/** The chat on screen right now, as a boolean so only its row and the one it left re-render. */
function useIsCurrentChat(chatId: number, nodeId?: string) {
  const onWorkbench = useNavigationStore((s) => s.main.kind === "workbench")
  const current = useEditorStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (tab?.type !== "chat") return false
    if (!nodeId) return !tab.nodeId && chatIdOfTab(tab) === chatId
    return sameChat(chatRefOfTab(tab) ?? chatRefFromTabId(tab.id), chatRefOf(chatId, nodeId))
  })
  return onWorkbench && current
}

const ChatRow = memo(function ChatRow({ chat, workspaceId, nodeId, onOpen }: {
  chat: ChatHistoryListItem
  workspaceId: number
  nodeId?: string
  onOpen: OpenTreeChat
}) {
  const intl = useIntl()
  const attention = useChatAttention(chat.id, nodeId)
  const current = useIsCurrentChat(chat.id, nodeId)
  // Agents and sub-tasks are this machine's (another machine's join in step 4).
  const hasChildren = useHasChatChildren(chat.id) && !nodeId
  const title = fileCitationsToText(chat.title) || "New chat"
  const wantsYou = attention === "needs" || attention === "done"
  const row = (
    <button
      type="button"
      data-testid={nodeId ? `sidebar-chat-${nodeId}-${chat.id}` : `sidebar-chat-${chat.id}`}
      aria-current={current ? "page" : undefined}
      onClick={() => onOpen(chat, workspaceId)}
      title={title}
      className={cn(
        treeRowClassName,
        // Room for the agents toggle, so it never covers the title.
        hasChildren && "pr-12",
        current && "bg-row-selected hover:bg-row-selected",
      )}
    >
      <AgentIcon providerId={chat.providerId} group={attention} />
      {/* Running shimmers the title, not the row: a lead and its agents often
          run at once, and stacked full-row sweeps merged into one blue block. */}
      <span className={cn(
        "min-w-0 flex-1 truncate text-sm",
        current || wantsYou ? "font-medium text-foreground" : "text-foreground/70",
        attention === "running" && "shimmer",
      )}>
        {title}
      </span>
      {/* On hover only: the title needs the room more, and whose turn it is
          already shows as the dot on the icon. A lead's slot holds its agents toggle. */}
      {chat.updatedAt > 0 && !hasChildren && (
        <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground/60 group-hover/chat-row:inline group-focus-visible/chat-row:inline [@media(hover:none)]:!hidden">
          {formatRelativeTime(intl, chat.updatedAt, { compact: true })}
        </span>
      )}
    </button>
  )
  if (!hasChildren) return row
  return <ChatWithAgents chatId={chat.id} workspaceId={workspaceId} current={current}>{row}</ChatWithAgents>
})

/**
 * Whether a conversation has dispatched any external agent, or (a board task's
 * session) handed out sub-tasks — as a boolean so rows re-render only when that flips.
 */
function useHasChatChildren(chatId: number) {
  const hasAgents = useExternalAgentsStore((s) => {
    for (const agent of s.agents.values()) {
      // The tree lists this machine's conversations.
      if (isOnNode(agent, undefined) && agent.parentChatId === chatId && !agent.assistantActivityId) return true
    }
    return false
  })
  const hasTasks = useProjectStore((s) => s.projects.some((p) => p.taskChildren?.some((c) => c.parentChatId === chatId)))
  return hasAgents || hasTasks
}

/** The conversation on screen in the workbench, if any. */
function useCurrentChatId() {
  const onWorkbench = useNavigationStore((s) => s.main.kind === "workbench")
  const chatId = useEditorStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.type === "chat" ? chatIdOfTab(tab) ?? null : null
  })
  return onWorkbench ? chatId : null
}

/**
 * A lead conversation with the external agents it dispatched nested under it.
 * Open on its own while any of them is in play (running, failed, waiting on you)
 * or one of them is on screen; folded once they are all finished. A click on the
 * toggle overrides that until the sidebar remounts.
 */
function ChatWithAgents({ chatId, workspaceId, current, children: row }: {
  chatId: number
  workspaceId: number
  current: boolean
  children: ReactNode
}) {
  const intl = useIntl()
  // The tree is this machine's conversations.
  const agents = useChatChildren(localChat(chatId))
  const counts = childCounts(agents)
  const currentChatId = useCurrentChatId()
  const [override, setOverride] = useState<boolean | null>(null)
  const inPlay = counts.needsYou + counts.failed + counts.running > 0
  const agentOnScreen = currentChatId != null && agents.some((agent) => agent.childChatId === currentChatId)
  const expanded = override ?? (inPlay || current || agentOnScreen)
  const groupId = useId()
  return (
    <>
      <div className="relative">
        {row}
        <button
          type="button"
          data-testid={`sidebar-chat-agents-toggle-${chatId}`}
          aria-expanded={expanded}
          aria-controls={groupId}
          aria-label={expanded
            ? intl.formatMessage({ id: "sidebar.agents.hide", defaultMessage: "Hide agents" })
            : intl.formatMessage({ id: "sidebar.agents.show", defaultMessage: "Show {count, plural, one {# agent} other {# agents}}" }, { count: counts.total })}
          title={intl.formatMessage(
            { id: "sidebar.agents.summary", defaultMessage: "{finished} of {total} agents finished" },
            { finished: counts.finished, total: counts.total },
          )}
          onClick={() => setOverride(!expanded)}
          className={cn(
            "absolute right-1.5 top-1/2 flex h-5 -translate-y-1/2 items-center gap-0.5 rounded-md px-1 text-[11px] tabular-nums transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            counts.needsYou > 0 ? "text-status-warn" : counts.failed > 0 ? "text-status-error" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {counts.finished}/{counts.total}
          <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} strokeWidth={1.75} />
        </button>
      </div>
      {expanded && (
        <div id={groupId} role="group" data-testid={`sidebar-chat-agents-${chatId}`}>
          {agents.map((agent) => (
            <AgentRow key={agent.key} agent={agent} parentWorkspaceId={workspaceId} current={agent.childChatId === currentChatId} />
          ))}
        </div>
      )}
    </>
  )
}

const AGENT_DOT: Partial<Record<ChildState, ActiveGroup>> = { "needs-you": "needs", running: "running" }

/** One dispatched agent under its lead: where it works and what it changed when that is a workspace of its own. */
function AgentRow({ agent, parentWorkspaceId, current }: {
  agent: ChatChild
  parentWorkspaceId: number
  current: boolean
}) {
  const intl = useIntl()
  const ownWorkspace = agent.workspaceId != null && (agent.nodeId != null || agent.workspaceId !== parentWorkspaceId) ? agent.workspaceId : undefined
  // A remote agent's workspace id is its machine's.
  const workspace = useProjectStore((s) => {
    if (ownWorkspace == null) return undefined
    for (const project of projectsOn(s, agent.nodeId)) {
      const found = project.workspaces.find((w) => w.id === ownWorkspace)
      if (found) return found
    }
    return undefined
  })
  const stats = useProjectStore((s) => (workspace ? s.workspaceDiffStats[workspace.worktreePath] : undefined))
  const finished = agent.state === "done" || agent.state === "stopped"
  const title = fileCitationsToText(agent.title) || "Agent"
  return (
    <button
      type="button"
      data-testid={`sidebar-agent-${agent.childChatId}`}
      aria-current={current ? "page" : undefined}
      onClick={() => void openChildChat(agent)}
      title={workspace ? `${title} · ${workspace.name}` : title}
      className={cn(
        treeRowClassName,
        // One more 12px step in from its lead.
        "pl-11",
        current && "bg-row-selected hover:bg-row-selected",
      )}
    >
      <AgentIcon providerId={agent.providerId} group={AGENT_DOT[agent.state] ?? null} />
      <span className={cn(
        "min-w-0 flex-1 truncate text-sm",
        current || agent.state === "needs-you" ? "font-medium text-foreground" : finished ? "text-muted-foreground" : "text-foreground/70",
        agent.state === "running" && "shimmer",
      )}>
        {title}
      </span>
      {agent.state === "failed" && (
        <span className="shrink-0 text-[11px] text-status-error">
          {intl.formatMessage({ id: "sidebar.agents.failed", defaultMessage: "Failed" })}
        </span>
      )}
      {stats && (stats.additions > 0 || stats.deletions > 0) && (
        <span className="shrink-0 text-[11px] tabular-nums opacity-80">
          {stats.additions > 0 && <span className="text-diff-add">+{stats.additions}</span>}
          {stats.deletions > 0 && <span className="ml-0.5 text-diff-remove">-{stats.deletions}</span>}
        </span>
      )}
      {/* Its workspace is in the tooltip: in a 240px panel a branch name beside the
          title cut both down to a few letters. */}
    </button>
  )
}

/** A workspace's latest conversations under its row, newest first. */
function WorkspaceChats({ workspaceId, nodeId, onOpenChat }: {
  workspaceId: number
  nodeId?: string
  onOpenChat: OpenTreeChat
}) {
  const intl = useIntl()
  const { chats: latest, hasMore, expanded, isFetching, loadMore, showLess } = useWorkspaceLatestChats(workspaceId, nodeId)
  // A sub-task working in this (shared) workspace shows under its parent's session instead.
  // Sub-tasks are this machine's Board's.
  const nested = useTaskChildChatIds()
  const chats = useMemo(() => nodeId ? latest : latest.filter((chat) => !nested.has(chat.id)), [latest, nested, nodeId])
  if (chats.length === 0) return null
  return (
    <div role="group" data-testid={nodeId ? `workspace-chats-${nodeId}-${workspaceId}` : `workspace-chats-${workspaceId}`}>
      {chats.map((chat) => (
        <ChatRow key={chat.id} chat={chat} workspaceId={workspaceId} nodeId={nodeId} onOpen={onOpenChat} />
      ))}
      {(hasMore || expanded) && (
        <button
          type="button"
          disabled={isFetching}
          onClick={hasMore ? loadMore : showLess}
          // Starts where the agent icons above do.
          className={cn(treeRowClassName, "text-xs text-muted-foreground hover:text-foreground disabled:opacity-60")}
        >
          {hasMore
            ? intl.formatMessage({ id: "sidebar.showMore", defaultMessage: "Show more" })
            : intl.formatMessage({ id: "sidebar.showLess", defaultMessage: "Show less" })}
        </button>
      )}
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
  /** Deep-link from an Active row with no tab open to its source (the chat, the task on the Board). */
  onOpenNotification?: (notification: Notification) => void
  /** Open a conversation by id: its tab wherever it is, else a new one in its workspace. */
  onOpenChat?: OpenChat
  collapsed?: boolean
  width?: number
  maxWidth?: string
}

// Panels floating out of the collapsed rail share one placement and surface.
// A floating surface (popover), not the sidebar grey: the rail they come out
// of is canvas-coloured now, so a grey panel read as a stray piece of sidebar.
// Light: white like the canvas, set off by the edge + float shadow (as Codex).
const railFlyoutClassName = "absolute bottom-2 left-[calc(100%+8px)] top-12 z-50 rounded-xl border border-border/60 bg-popover shadow-float"
const railFlyoutEnterClassName = "animate-in fade-in-0 slide-in-from-left-1 duration-150"
const RAIL_FLYOUT_MAX_WIDTH = "calc(100vw - 68px)"

const noop = () => {}

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
  icon: LucideIcon | ComponentType<{ className?: string }>
  label: string
  /** Sidebar mode; a change dismisses an open tooltip. */
  collapsed: boolean
  active?: boolean
  count?: number
  actionCount?: number
  tooltip?: boolean
  /** Off for buttons whose hover floats a panel: the tooltip then stays keyboard-only. */
  hoverTooltip?: boolean
}

// One rail slot: 40px tall, its 4px transparent border insetting the
// hover/selection fill to a 32px pill with an 8px radius.
const navItemClassName = (active: boolean | undefined) => cn(
  "relative flex h-10 w-full shrink-0 items-center gap-2 rounded-xl border-4 border-transparent bg-clip-padding px-1.5 text-left text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  active ? "bg-row-selected text-foreground hover:bg-row-selected" : "text-foreground/85 hover:bg-row-hover hover:text-foreground",
)

/** A rail destination: icon only in both sidebar modes, named by its tooltip. */
function SidebarNavItem({ icon: Icon, label, collapsed, active, count = 0, actionCount = 0, tooltip = true, hoverTooltip = true, className, ...props }: SidebarNavItemProps) {
  const total = actionCount || count
  const [tooltipOpen, setTooltipOpen] = useState(false)

  useEffect(() => {
    setTooltipOpen(false)
  }, [collapsed, tooltip])

  return (
    <Tooltip
      key={collapsed ? "collapsed" : "expanded"}
      delayDuration={600}
      open={tooltip && tooltipOpen}
      onOpenChange={(open) => setTooltipOpen(tooltip && open)}
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
          if (event.key === "Tab") setTooltipOpen(tooltip)
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
          {total > 0 && (
            <span className={cn(
              "absolute -right-0.5 top-0 min-w-3 shrink-0 text-center text-[10px] font-medium tabular-nums animate-in fade-in duration-150",
              actionCount > 0 ? "rounded-full bg-accent-warm px-1 text-white" : "text-tint",
            )}>
              {total > 99 ? "99+" : total}
            </span>
          )}
        </button>
      </TooltipTrigger>
      {tooltip && <TooltipContent side="right">{label}</TooltipContent>}
    </Tooltip>
  )
}

/**
 * The rail's Projects button. It carries the cross-project badge (chats waiting
 * on the user or with a reply they have not read): with the panel away it is
 * the only place that says so. Its own component: the badge follows every tab,
 * turn and inbox event.
 */
function ProjectsRailButton(props: Omit<SidebarNavItemProps, "icon" | "count" | "actionCount">) {
  const { needs, done } = useActiveAttentionCounts()
  return <SidebarNavItem icon={Folder} count={needs + done} actionCount={needs} {...props} />
}

/**
 * The rail's Channels button, badged like Projects: amber with the number of
 * things waiting on you (approvals, a "waiting" thread you haven't read) when
 * there are any, else a tint count of channels with unread agent messages. Its
 * own component so the count's updates re-render only this button.
 */
function ChannelsRailButton(props: Omit<SidebarNavItemProps, "icon" | "count" | "actionCount">) {
  const unread = useChannelUnreadMap()
  let count = 0
  let attention = 0
  for (const u of unread.values()) {
    if (hasUnread(u)) count += 1
    attention += attentionOf(u)
  }
  return <SidebarNavItem icon={Hash} count={count} actionCount={attention} {...props} />
}

export function ProjectSidebar({ onOpenSpec, onOpenNotification, onOpenChat, collapsed = false, width = LEFT_SIDEBAR_DEFAULT_WIDTH, maxWidth }: ProjectSidebarProps) {
  const intl = useIntl()
  const machine = useContext(MachineActionsContext)
  const projectsLabel = intl.formatMessage({ id: "sidebar.projects", defaultMessage: "Projects" })
  const channelsLabel = intl.formatMessage({ id: "sidebar.channels", defaultMessage: "Channels" })
  const focusLabel = intl.formatMessage({ id: "sidebar.focus", defaultMessage: "Focus" })
  const addRepositoryLabel = intl.formatMessage({ id: "sidebar.addRepository", defaultMessage: "Add repository" })
  // Collapsed by the user, as opposed to the panel making way off the workspace views.
  const userCollapsed = useAppShellStore((s) => s.sidebarCollapsed)
  const mainView = useNavigationStore((s) => s.main)
  const showMain = useNavigationStore((s) => s.showMain)
  const showWorkbench = useNavigationStore((s) => s.showWorkbench)
  const openPage = useNavigationStore((s) => s.openPage)
  const assistantActive = mainView.kind === "assistant"
  const sidebarFocus = useAppShellStore((s) => s.sidebarFocus)
  const setSidebarFocus = useAppShellStore((s) => s.setSidebarFocus)
  const boardActive = mainView.kind === "board" && mainView.view === "board"
  const channelsActive = mainView.kind === "board" && mainView.view === "channels"
  const activeSpecId = mainView.kind === "spec" ? mainView.taskId : null
  const canAddProject = __APP_TARGET__ !== "web"
  const projects = useProjectStore((s) => s.projects)
  const projectsLoaded = useProjectStore((s) => s.projectsLoaded)
  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)
  // The current workspace's machine: this tree's ids mean nothing on another one.
  const activeNodeId = useProjectStore((s) => s.activeNodeId)
  const otherMachines = useOtherMachines()
  const thisMachineLabel = useThisMachineLabel()
  const [localTreeOpen, setLocalTreeOpen] = useState(true)
  const addProject = useProjectStore((s) => s.addProject)
  const setActiveWorkspace = useProjectStore((s) => s.setActiveWorkspace)
  const setProjectWorkspaces = useProjectStore((s) => s.setProjectWorkspaces)
  const setProjectPinned = useProjectStore((s) => s.setProjectPinned)
  const workspaceDiffStats = useProjectStore((s) => s.workspaceDiffStats)
  const [projectErrors, setProjectErrors] = useState<Record<string, string | null>>({})

  const clearUnseen = useStreamingStore((s) => s.clearUnseen)
  const assistantAction = useInboxStore((s) => s.counts.assistantAction ?? 0)
  const assistantTotal = useInboxStore((s) => s.counts.assistantTotal ?? 0)

  const [newWorkspaceProjectId, setNewWorkspaceProjectId] = useState<number | null>(null)
  const projectsTriggerRef = useRef<HTMLButtonElement>(null)
  const projectTreeRef = useRef<HTMLDivElement>(null)
  const projectTreeId = useId()
  const channelsTriggerRef = useRef<HTMLButtonElement>(null)
  const channelListRef = useRef<HTMLDivElement>(null)
  const channelListId = useId()
  const { flyout, close: closeFlyout, pin: pinFlyout, holdOpen: holdFlyoutOpen, triggerHover, panelHover } = useRailFlyout()
  const flyoutOpen = collapsed && flyout !== null
  const flyoutPinned = flyoutOpen && flyout.pinned
  const floating = collapsed && flyout?.kind === "projects"
  const floatingChannels = collapsed && flyout?.kind === "channels"
  const flyoutKind = flyout?.kind

  // Escape: the floating list is about to go inert, so hand focus back to its
  // trigger rather than drop it. Only if it is in there: a hover-opened panel
  // must not pull focus from the composer.
  const closePreview = useCallback(() => {
    closeFlyout()
    if (projectTreeRef.current?.contains(document.activeElement)) {
      projectsTriggerRef.current?.focus({ preventScroll: true })
    } else if (channelListRef.current?.contains(document.activeElement)) {
      channelsTriggerRef.current?.focus({ preventScroll: true })
    }
  }, [closeFlyout])

  // A row took the user somewhere else. Focus leaves the tree instead of going
  // to the rail's Projects button: the rail is there in both modes now, and a
  // focused rail button opens its tooltip. Stable, so the memoized rows keep.
  const closeAfterNavigate = useCallback(() => {
    closeFlyout()
    const focused = document.activeElement
    if (focused instanceof HTMLElement && (projectTreeRef.current?.contains(focused) || channelListRef.current?.contains(focused))) focused.blur()
  }, [closeFlyout])

  useEffect(() => {
    if (!collapsed) closeFlyout()
  }, [collapsed, closeFlyout])

  useEffect(() => {
    if (!flyoutOpen || newWorkspaceProjectId !== null) return
    const tree = flyoutKind === "channels" ? channelListRef.current : projectTreeRef.current
    const trigger = flyoutKind === "channels" ? channelsTriggerRef.current : projectsTriggerRef.current
    const isInside = (target: EventTarget | null) => target instanceof Node &&
      (tree?.contains(target) || trigger?.contains(target))
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
  }, [flyoutOpen, flyoutKind, flyoutPinned, closeFlyout, closePreview, newWorkspaceProjectId])

  const handleOpenSpec = useCallback((taskId: number, projectId: number) => {
    onOpenSpec?.(taskId, projectId)
    closeAfterNavigate()
  }, [onOpenSpec, closeAfterNavigate])

  // Clear unseen when user switches to a workspace. Tabs are read at click time
  // rather than subscribed: they change on every send (chat id, title, draft),
  // and subscribing re-rendered the whole sidebar each time (~12ms in dev).
  const handleSelectWorkspace = useCallback((workspaceId: number, projectId: number) => {
    const { currentWorkspaceId, tabs: currentTabs, workspaceStates } = useEditorStore.getState()
    const tabs = workspaceId === currentWorkspaceId ? currentTabs : (workspaceStates[String(workspaceId)]?.tabs ?? [])
    const chatTabIds = tabs.filter((t) => t.type === "chat").map((t) => t.id)
    if (chatTabIds.length > 0) clearUnseen(chatTabIds)
    setActiveWorkspace(workspaceId, projectId)
    // Picking a workspace leaves the Assistant / Board view.
    showWorkbench()
    closeAfterNavigate()
  }, [clearUnseen, setActiveWorkspace, showWorkbench, closeAfterNavigate])

  // Another machine's workspace: that machine becomes the workbench's.
  const handleSelectRemoteWorkspace = useCallback((nodeId: string, workspaceId: number, projectId: number) => {
    const { currentWorkspaceId, currentNodeId, tabs: currentTabs, workspaceStates } = useEditorStore.getState()
    const tabs = workspaceId === currentWorkspaceId && currentNodeId === nodeId
      ? currentTabs
      : workspaceStates[workspaceBucketKey(workspaceId, nodeId)]?.tabs ?? []
    const chatTabIds = tabs.filter((t) => t.type === "chat").map((t) => t.id)
    if (chatTabIds.length > 0) clearUnseen(chatTabIds)
    setActiveWorkspace(workspaceId, projectId, nodeId)
    showWorkbench()
    closeAfterNavigate()
  }, [clearUnseen, setActiveWorkspace, showWorkbench, closeAfterNavigate])

  const handleNewChatInRemoteWorkspace = useCallback((nodeId: string, workspaceId: number, projectId: number) => {
    void startNewChatInWorkspace(workspaceId, projectId, nodeId)
    closeAfterNavigate()
  }, [closeAfterNavigate])

  // Another machine's chat opens in its workspace there, like a local one does.
  const handleOpenRemoteChat = useCallback((nodeId: string, chat: ChatHistoryListItem, workspaceId: number, projectId: number) => {
    const ref = { nodeId, chatId: chat.id }
    const editor = useEditorStore.getState()
    const existing = editor.findChatTab(ref)
    const targetWorkspace = existing?.workspaceId ?? workspaceId
    const projects = useProjectStore.getState()
    if (projects.activeWorkspaceId !== targetWorkspace || projects.activeNodeId !== nodeId) {
      setActiveWorkspace(targetWorkspace, targetWorkspace === workspaceId ? projectId : undefined, nodeId)
    }
    showWorkbench()
    const tabId = useEditorStore.getState().openChatTab(existing?.tabId ?? chatTabId(ref), chat.title || "Chat")
    useEditorStore.getState().setTabChatId(tabId, chat.id)
    closeAfterNavigate()
  }, [setActiveWorkspace, showWorkbench, closeAfterNavigate])

  const handleNewChatInWorkspace = useCallback((workspaceId: number, projectId: number) => {
    void startNewChatInWorkspace(workspaceId, projectId)
    closeAfterNavigate()
  }, [closeAfterNavigate])

  const handleOpenChat = useCallback<OpenTreeChat>((chat, workspaceId) => {
    // Coming back to a chat from the list shows its latest output.
    useNavigationStore.getState().requestChatLatest(chat.id)
    onOpenChat?.({ chatId: chat.id, workspaceId, title: chat.title })
    closeAfterNavigate()
  }, [onOpenChat, closeAfterNavigate])

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

    try {
      await createProjectWorkspace(project, branchName)
      await syncWorktrees(project)
    } catch (error) {
      console.error("Failed to add worktree:", error)
      setProjectErrors((prev) => ({ ...prev, [String(project.id)]: "Failed to create worktree." }))
      throw error
    }
  }

  const onWorkspaceView = isWorkspaceView(mainView)
  const projectsSelected = onWorkspaceView || floating
  // Expanded, the panel holds the channel list on Channels and the project tree
  // everywhere else; collapsed, each shows only while it floats.
  const treeShown = collapsed ? floating : !channelsActive
  const channelListShown = collapsed ? floatingChannels : channelsActive
  const bottomInset = "pb-[max(0.75rem,var(--ios-shell-safe-bottom,0px))]"

  // Two columns: the icon rail, identical in both modes, and the panel beside
  // it (the project tree or the Active list), which is what collapses. The
  // panel's content keeps its full width and is clipped while it animates:
  // reflowing the tree every frame would cost a layout.
  return (
    <div className="relative flex h-full w-full min-h-0 sidebar-surface-fade text-sidebar-foreground">
      <WorkspaceDiffStatsSync />

      <div data-testid="sidebar-rail" className={cn("flex min-h-0 shrink-0 flex-col", bottomInset)} style={{ width: LEFT_SIDEBAR_RAIL_WIDTH }}>
        {/* Titlebar cell: the traffic lights and the sidebar toggle sit across it. */}
        <div className="drag-region h-10 shrink-0" />

        <nav aria-label="Workspace navigation" className="relative shrink-0 space-y-1 px-1.5">
          <SidebarNavItem icon={SquarePen} label={intl.formatMessage({ id: "sidebar.newChat", defaultMessage: "New chat" })} collapsed={collapsed}
            data-testid="sidebar-new-chat"
            onClick={() => { closeFlyout(); void startNewChat() }} />
          <SidebarNavItem icon={MessageCircle} label={intl.formatMessage({ id: "sidebar.assistant", defaultMessage: "Assistant" })} collapsed={collapsed} active={assistantActive}
            count={assistantTotal} actionCount={assistantAction}
            onClick={() => { closeFlyout(); showMain({ kind: "assistant" }) }} />
          <SidebarNavItem icon={LayoutDashboard} label={intl.formatMessage({ id: "sidebar.board", defaultMessage: "Board" })} collapsed={collapsed} active={boardActive}
            onClick={() => { closeFlyout(); showMain({ kind: "board", view: "board" }); trackEvent("page_opened", { page: "board" }) }} />
          <ChannelsRailButton ref={channelsTriggerRef} label={channelsLabel} collapsed={collapsed} active={channelsActive || floatingChannels}
            aria-expanded={collapsed ? floatingChannels : undefined} aria-controls={channelListId} aria-haspopup={collapsed ? "dialog" : undefined}
            tooltip={!floatingChannels} hoverTooltip={!collapsed}
            {...(collapsed ? triggerHover("channels") : {})}
            onClick={() => {
              // Elsewhere it goes to the page; on the page with the panel
              // collapsed it floats the channel list, pinned, like Projects.
              if (!channelsActive || !collapsed) {
                closeFlyout()
                showMain({ kind: "board", view: "channels" })
                trackEvent("page_opened", { page: "channels" })
              } else if (floatingChannels && flyoutPinned) {
                closeFlyout()
              } else {
                pinFlyout("channels")
              }
            }} />
          <ProjectsRailButton ref={projectsTriggerRef} label={projectsLabel} collapsed={collapsed}
            active={projectsSelected} data-testid="sidebar-projects-button"
            aria-expanded={collapsed ? floating : undefined} aria-controls={projectTreeId} aria-haspopup={collapsed ? "dialog" : undefined}
            tooltip={!floating} hoverTooltip={!collapsed}
            {...(collapsed ? triggerHover("projects") : {})}
            onClick={() => {
              // Off the workspace views the panel only made way: going back
              // to the workspace brings it back with it.
              if (!onWorkspaceView && !userCollapsed) {
                closeFlyout()
                showWorkbench()
              } else if (!collapsed) {
                showWorkbench()
              } else if (floating && flyoutPinned) {
                // A click landing just after the hover delay must not close
                // what just opened, so it pins; only a pinned panel toggles shut.
                closeFlyout()
              } else {
                pinFlyout("projects")
              }
            }} />
        </nav>

        <div className="min-h-0 flex-1" />

        <nav aria-label="Tools and settings" className="relative shrink-0 space-y-1 px-1.5 pt-2">
          {/* A pending update shows above this group, out of the layout. */}
          <div className="absolute bottom-full left-1.5 mb-1 w-10">
            <UpdateReadyPill variant="rail" />
          </div>
          {/* Account quota rings: app-level status, so it heads the app-level group. */}
          <AccountUsageRail className="pb-1" />
          <SidebarNavItem icon={Network} label={intl.formatMessage({ id: "sidebar.workflow", defaultMessage: "Workflow" })} collapsed={collapsed}
            onClick={() => openPage({ kind: "canvas" })} />
          <SidebarNavItem icon={Package} label={intl.formatMessage({ id: "sidebar.plugins", defaultMessage: "Plugins" })} collapsed={collapsed}
            onClick={() => openPage({ kind: "plugins" })} />
          <SidebarNavItem icon={CalendarClock} label={intl.formatMessage({ id: "sidebar.schedule", defaultMessage: "Schedule" })} collapsed={collapsed}
            onClick={() => openPage({ kind: "schedule" })} />
          <SidebarNavItem icon={Settings} label={intl.formatMessage({ id: "sidebar.settings", defaultMessage: "Settings" })} collapsed={collapsed}
            data-testid="settings-button" onClick={() => openPage({ kind: "settings" })} />
        </nav>
        {machine && <MachineSwitcher machine={machine} />}
      </div>

      {/* The panel. Positioned and clipping only while it is (or is becoming)
          visible: once collapsed, the tree inside floats out of the rail and
          must be placed against the root, not cut off by a 0px column. */}
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !collapsed && "relative overflow-hidden")}>
        {!collapsed && (
          <>
            {/* Rail/panel divider, below the titlebar band the traffic lights cross. */}
            <div aria-hidden className="pointer-events-none absolute bottom-0 left-0 top-10 z-10 w-px bg-border/50 sidebar-label-fade" />
            <div className="drag-region h-10 shrink-0" style={{ width, maxWidth }} />
          </>
        )}

        {/* One mounted tree: switching the sidebar mode keeps its scroll and
            folder state. */}
        <div
          ref={projectTreeRef}
          id={projectTreeId}
          data-testid="project-tree"
          role={collapsed ? "dialog" : "region"}
          aria-label={projectsLabel}
          aria-hidden={!treeShown}
          inert={!treeShown}
          tabIndex={-1}
          className={cn(
            "flex min-h-0 flex-col outline-none",
            collapsed
              ? cn(railFlyoutClassName, "py-2")
              : cn("sidebar-label-fade flex-1", bottomInset),
            !treeShown && "invisible pointer-events-none opacity-0",
            // Kept mounted (scroll and folders stay) but out of the column while
            // the channel list has the panel.
            !collapsed && !treeShown && "absolute inset-x-0 bottom-0 top-10",
            floating && railFlyoutEnterClassName,
          )}
          style={{ width, maxWidth: collapsed ? RAIL_FLYOUT_MAX_WIDTH : maxWidth }}
          {...panelHover}
        >
          {/* pr-3: the action icons end where the rows' content does. */}
          <div className="h-9 pl-4 pr-3 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 heading-section">
              <span>{sidebarFocus ? focusLabel : projectsLabel}</span>
            </div>
            <div className="flex items-center gap-0.5">
              {/* Swaps the tree for what wants the user, then every chat by day. */}
              <Button
                variant="ghost"
                size="icon"
                data-testid="sidebar-focus-button"
                className={cn("h-6 w-6 rounded-md text-muted-foreground hover:text-foreground", sidebarFocus && "bg-row-selected text-foreground hover:bg-row-selected")}
                onClick={() => setSidebarFocus(!sidebarFocus)}
                title={focusLabel}
                aria-label={focusLabel}
                aria-pressed={sidebarFocus}
              >
                <ListFilter className="h-4 w-4" />
              </Button>
              {canAddProject && !sidebarFocus && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 rounded-md text-muted-foreground hover:text-foreground"
                  onClick={handleAddProject}
                  title={addRepositoryLabel}
                  aria-label={addRepositoryLabel}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
          <ScrollArea className="flex-1 min-h-0 [&>[data-slot=scroll-area-viewport]>div]:!block [&>[data-slot=scroll-area-viewport]>div]:!min-w-0" viewportClassName="scroll-fade-y [--scroll-fade-gutter:0px]">
            <div className="space-y-0.5 pb-3 pt-0">
              {/* With other machines on the account, each machine heads its own tree. */}
              {!sidebarFocus && otherMachines.length > 0 && (
                <MachineHeader
                  label={thisMachineLabel ?? intl.formatMessage({ id: "sidebar.machine.this", defaultMessage: "This machine" })}
                  open={localTreeOpen}
                  onToggle={() => setLocalTreeOpen(!localTreeOpen)}
                />
              )}
              {sidebarFocus ? (
                <FocusConversations onOpenNotification={onOpenNotification ?? noop} onOpenChat={onOpenChat ?? noop} onNavigate={closeAfterNavigate} />
              ) : otherMachines.length > 0 && !localTreeOpen ? null : projects.length === 0 && !projectsLoaded ? (
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
                      <div className="mx-3 my-1 border-t border-border/40" />
                    )}
                    <ProjectItem
                      project={project}
                      onSelectWorkspace={handleSelectWorkspace}
                      onNewChatInWorkspace={handleNewChatInWorkspace}
                      onOpenChat={handleOpenChat}
                      // Only one place is "current": while the Assistant is showing, no workspace is.
                      activeWorkspaceId={assistantActive || boardActive || channelsActive || activeSpecId != null || activeNodeId != null ? null : activeWorkspaceId}
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
              {!sidebarFocus && otherMachines.length > 0 && (
                <RemoteMachineTrees
                  machines={otherMachines}
                  activeNodeId={activeNodeId}
                  activeWorkspaceId={assistantActive || boardActive || channelsActive || activeSpecId != null ? null : activeWorkspaceId}
                  renderWorkspace={(nodeId, workspace, projectId, isActive) => (
                    <WorkspaceEntry
                      key={workspace.id}
                      workspace={workspace}
                      projectId={projectId}
                      nodeId={nodeId}
                      isActive={isActive}
                      onSelectWorkspace={(workspaceId, id) => handleSelectRemoteWorkspace(nodeId, workspaceId, id)}
                      onNewChatInWorkspace={(workspaceId, id) => handleNewChatInRemoteWorkspace(nodeId, workspaceId, id)}
                      onOpenChat={(chat, workspaceId) => handleOpenRemoteChat(nodeId, chat, workspaceId, projectId)}
                    />
                  )}
                />
              )}
              {/* Below the tree, every conversation in play across projects. */}
              {!sidebarFocus && <RecentConversations onOpenNotification={onOpenNotification ?? noop} onOpenChat={onOpenChat ?? noop} onNavigate={closeAfterNavigate} />}
            </div>
          </ScrollArea>
        </div>

        {/* The channel list: the panel's content on Channels, and what floats
            out of the rail's # when the panel is collapsed. */}
        <div
          ref={channelListRef}
          id={channelListId}
          data-testid="channel-list"
          role={collapsed ? "dialog" : "region"}
          aria-label={channelsLabel}
          aria-hidden={!channelListShown}
          inert={!channelListShown}
          tabIndex={-1}
          className={cn(
            "flex min-h-0 flex-col outline-none",
            collapsed
              ? cn(railFlyoutClassName, "py-2")
              : cn("sidebar-label-fade flex-1", bottomInset),
            !channelListShown && "invisible pointer-events-none opacity-0",
            !collapsed && !channelListShown && "absolute inset-x-0 bottom-0 top-10",
            floatingChannels && railFlyoutEnterClassName,
          )}
          style={{ width, maxWidth: collapsed ? RAIL_FLYOUT_MAX_WIDTH : maxWidth }}
          {...panelHover}
        >
          <ChannelList shown={channelListShown} onNavigate={closeAfterNavigate} />
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
