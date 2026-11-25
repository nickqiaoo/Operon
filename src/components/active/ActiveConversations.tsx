import { useCallback, useEffect, useMemo } from "react"
import { defineMessages, FormattedMessage, useIntl, type IntlShape } from "react-intl"
import { useQueryClient } from "@tanstack/react-query"
import { CheckCheck, MessageSquare } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useShallow } from "zustand/react/shallow"
import { ProviderIcon } from "@/components/icons/ProviderLabel"
import { localizeNotification } from "@/components/inbox/localize-notification"
import { chatHistoryKeys, useChatHistoryList, useRecentChats } from "@/lib/chat-queries"
import { formatRelativeTime } from "@/lib/format"
import { fileCitationsToText } from "@/lib/file-citation"
import { useInboxUnread } from "@/lib/inbox-queries"
import {
  activeAttentionCounts,
  buildActiveEntries,
  chatIdOfTab,
  entryNotificationIds,
  focusPriorityEntries,
  unreadNotificationIds,
  type ActiveEntry,
  type ActiveGroup,
  type OpenChat,
} from "@/lib/active-conversations"
import { cn } from "@/lib/utils"
import { useChatPendingInputStore } from "@/stores/chat-pending-input-store"
import { useChatRunningStore } from "@/stores/chat-running-store"
import { LOCAL_NODE, chatKey, chatRefFromTabId, chatRefOfTab, localChat, nodeChatIds, nodeEntries, parseWorkspaceBucketKey, sameChat, workspaceBucketKey } from "@/lib/chat-ref"
import { useEditorStore } from "@/stores/editor-store"
import { useInboxStore } from "@/stores/inbox-store"
import { useNavigationStore } from "@/stores/navigation-store"
import { useProjectStore } from "@/stores/project-store"
import { useStreamingStore } from "@/stores/streaming-store"
import { isAssistantNotification, type Notification } from "@/types/notification"
import { isOnNode, useExternalAgentsStore } from "@/stores/external-agents-store"
import type { EditorTab } from "@/types/editor"

const messages = defineMessages({
  recent: { id: "sidebar.recent", defaultMessage: "Recent" },
  priority: { id: "focus.priority", defaultMessage: "Priority" },
  today: { id: "focus.today", defaultMessage: "Today" },
  yesterday: { id: "focus.yesterday", defaultMessage: "Yesterday" },
  earlier: { id: "focus.earlier", defaultMessage: "Earlier" },
  nothingPending: { id: "focus.nothingPending", defaultMessage: "Nothing waiting on you" },
  markAllRead: { id: "focus.markAllRead", defaultMessage: "Mark all read" },
  showMore: { id: "sidebar.showMore", defaultMessage: "Show more" },
})

/**
 * The Active rows, live. Subscribe in a leaf: it changes on every tab, turn and
 * inbox event. `includeInfo` adds unread notices that ask nothing (see `ActiveInput`).
 */
export function useActiveConversations({ includeInfo = false }: { includeInfo?: boolean } = {}): ActiveEntry[] {
  const { tabs, currentWorkspaceId, currentNodeId, workspaceStates } = useEditorStore(useShallow((s) => ({
    tabs: s.tabs,
    currentNodeId: s.currentNodeId,
    currentWorkspaceId: s.currentWorkspaceId,
    workspaceStates: s.workspaceStates,
  })))
  const projects = useProjectStore((s) => s.projects)
  const pendingByChat = useChatPendingInputStore((s) => s.pendingByChat)
  const runningChats = useChatRunningStore((s) => s.runningChats)
  // The sidebar lists this machine's conversations.
  const runningChatIds = useMemo(() => nodeChatIds(runningChats, LOCAL_NODE), [runningChats])
  const { streamingTabIds, unseenTabIds } = useStreamingStore(useShallow((s) => ({
    streamingTabIds: s.streamingTabIds,
    unseenTabIds: s.unseenTabIds,
  })))
  const { data: unread } = useInboxUnread()
  const { data: recentChats } = useRecentChats()
  const externalAgents = useExternalAgentsStore((s) => s.agents)
  const parentOfChat = useMemo(() => {
    const parents = new Map<number, number>()
    for (const agent of externalAgents.values()) {
      // These lists are this machine's conversations.
      if (!isOnNode(agent, undefined)) continue
      // The assistant's agents have parentChatId 0: no lead row to fold them into.
      // One started on another machine lives there: its chat id is not one of these.
      if (agent.parentChatId > 0 && !agent.assistantActivityId && !agent.remote) parents.set(agent.childChatId, agent.parentChatId)
    }
    // A board sub-task's session folds into its parent task's session the same way.
    for (const project of projects) {
      for (const child of project.taskChildren ?? []) parents.set(child.chatId, child.parentChatId)
    }
    return parents
  }, [externalAgents, projects])

  // A turn starting or ending moves its chat to the top of the recent list.
  const queryClient = useQueryClient()
  const runningKey = useMemo(() => [...runningChatIds].sort((a, b) => a - b).join(","), [runningChatIds])
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: chatHistoryKeys.recent() })
    // …and to the top of its workspace's rows in the tree.
    void queryClient.invalidateQueries({ queryKey: chatHistoryKeys.allLists() })
  }, [queryClient, runningKey])

  return useMemo(() => {
    const currentKey = workspaceBucketKey(currentWorkspaceId, currentNodeId)
    const buckets = [
      { workspaceId: currentWorkspaceId, tabs },
      ...Object.entries(workspaceStates)
        .filter(([key]) => key !== currentKey)
        .map(([key, bucket]) => ({ ...parseWorkspaceBucketKey(key), tabs: bucket.tabs }))
        // These lists are this machine's conversations.
        .filter((bucket) => bucket.nodeId == null),
    ]
    const projectByWorkspace = new Map<number, number>()
    for (const project of projects) for (const workspace of project.workspaces) projectByWorkspace.set(workspace.id, project.id)
    return buildActiveEntries({
      buckets,
      recentChats: recentChats ?? [],
      unread: unread ?? [],
      pendingChatIds: new Set(nodeEntries(pendingByChat, LOCAL_NODE).keys()),
      runningChatIds,
      streamingTabIds,
      unseenTabIds,
      projectOfWorkspace: (workspaceId) => projectByWorkspace.get(workspaceId) ?? null,
      includeInfo,
      parentOfChat,
    })
  }, [tabs, currentWorkspaceId, currentNodeId, workspaceStates, projects, pendingByChat, runningChatIds, streamingTabIds, unseenTabIds, unread, recentChats, includeInfo, parentOfChat])
}

/** The Focus view's priority rows: everything that wants the user, a running turn, an unread notice. */
export function useFocusPriority(): ActiveEntry[] {
  const entries = useActiveConversations({ includeInfo: true })
  return useMemo(() => focusPriorityEntries(entries), [entries])
}

/** A row's title: the chat's own, or its notification's localized one. */
export function activeEntryTitle(entry: ActiveEntry, intl: IntlShape): string {
  return entry.titleFromNotification && entry.notification
    ? localizeNotification(entry.notification, intl).title
    : fileCitationsToText(entry.title)
}

/** Needs-you and done rows, for the rail icon's badge. */
export function useActiveAttentionCounts(): { needs: number; done: number } {
  return activeAttentionCounts(useActiveConversations())
}

/**
 * Go to an Active row. A conversation goes through App's `openChat`, which
 * focuses its tab wherever it is open and otherwise opens one in its workspace;
 * a board item goes wherever its notification points.
 */
function useOpenActiveEntry(onOpenNotification: (notification: Notification) => void, onOpenChat: OpenChat) {
  return useCallback((entry: ActiveEntry) => {
    const navigation = useNavigationStore.getState()
    // A task's row goes to the task, even when its session is what it is shown by:
    // that is where its review, comments and replies are.
    if (entry.notification?.taskId != null) {
      const ids = entryNotificationIds(entry)
      if (ids.length > 0) void useInboxStore.getState().markRead(ids)
      onOpenNotification(entry.notification)
      return
    }
    if (entry.chatId != null) {
      // Re-entering from the session list should show the latest output,
      // including a running turn whose tab still holds an earlier position.
      navigation.requestChatLatest(entry.chatId)
      onOpenChat({
        chatId: entry.chatId,
        workspaceId: entry.workspaceId ?? undefined,
        title: entry.titleFromNotification ? undefined : entry.title,
      })
      return
    }
    if (entry.tab) {
      // A new chat's first turn: no id to open it by yet, only its tab.
      const { tab } = entry
      if (tab.workspaceId !== useEditorStore.getState().currentWorkspaceId) {
        const project = tab.workspaceId == null
          ? undefined
          : useProjectStore.getState().projects.find((p) => p.workspaces.some((w) => w.id === tab.workspaceId))
        useProjectStore.getState().setActiveWorkspace(tab.workspaceId, project?.id)
      }
      useEditorStore.getState().setActiveTab(tab.tabId)
      navigation.showWorkbench()
      return
    }
    if (entry.notification) {
      if (entry.notification.readAt == null) void useInboxStore.getState().markRead([entry.notification.id])
      onOpenNotification(entry.notification)
    }
  }, [onOpenNotification, onOpenChat])
}

const STATUS_DOT: Partial<Record<ActiveGroup, string>> = {
  needs: "bg-accent-warm",
  done: "bg-tint",
  running: "bg-status-info animate-pulse",
}

/** The agent the conversation runs on, with whose turn it is as a dot on its corner. */
export function AgentIcon({ providerId, group, ringClassName = "ring-sidebar" }: {
  providerId?: string
  group: ActiveGroup | null
  /** The dot's ring: the color of the surface the icon sits on. */
  ringClassName?: string
}) {
  const dot = group ? STATUS_DOT[group] : undefined
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      {providerId
        ? <ProviderIcon id={providerId} size={14} />
        : <MessageSquare className="size-3.5 text-muted-foreground" strokeWidth={1.75} />}
      {dot && <span className={cn("absolute -bottom-0.5 -right-0.5 size-[7px] rounded-full ring-2", ringClassName, dot)} />}
    </span>
  )
}

/** "Project / Workspace" for a row, from what the project store knows. */
export function useLocationLabel() {
  const projects = useProjectStore((s) => s.projects)
  return useCallback((entry: ActiveEntry) => {
    const project = entry.projectId != null
      ? projects.find((p) => p.id === entry.projectId)
      : entry.workspaceId != null
        ? projects.find((p) => p.workspaces.some((w) => w.id === entry.workspaceId))
        : undefined
    const workspace = entry.workspaceId != null ? project?.workspaces.find((w) => w.id === entry.workspaceId) : undefined
    return [project?.name, workspace?.name].filter(Boolean).join(" / ")
  }, [projects])
}

/** One line per conversation, to keep the list short; the project and workspace are in its tooltip. */
function ActiveRow({ entry, current, location, showLocation = false, onOpen }: {
  entry: ActiveEntry
  current: boolean
  location: string
  /** Name the project at the row's end (the Focus view, where nothing else says where it is). */
  showLocation?: boolean
  onOpen: (entry: ActiveEntry) => void
}) {
  const intl = useIntl()
  const title = activeEntryTitle(entry, intl)
  const wantsYou = entry.group === "needs" || entry.group === "done"
  return (
    <button
      type="button"
      data-testid="active-row"
      data-group={entry.group}
      onClick={() => onOpen(entry)}
      aria-current={current ? "page" : undefined}
      title={location ? `${title}\n${location}` : title}
      className={cn(
        "flex h-7 w-full min-w-0 items-center gap-2 rounded-lg pl-2 pr-2 text-left transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
        current && "bg-row-selected hover:bg-row-selected",
        entry.group === "running" && "animate-shimmer-sweep",
      )}
    >
      <AgentIcon providerId={entry.providerId} group={entry.group} />
      <span className={cn("min-w-0 flex-1 sidebar-title-fade text-sm", wantsYou ? "font-medium text-foreground" : "text-foreground/70")}>
        {title}
      </span>
      {showLocation ? location && (
        <span className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground/60">
          {location.split(" / ")[0]}
        </span>
      ) : wantsYou && entry.at > 0 && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
          {formatRelativeTime(intl, entry.at, { compact: true })}
        </span>
      )}
    </button>
  )
}

interface RecentConversationsProps {
  onOpenNotification: (notification: Notification) => void
  onOpenChat: OpenChat
  /** After a row was used, e.g. to close the flyout holding the list. */
  onNavigate?: () => void
}

/**
 * The tree's Recent section: every conversation in play across projects, the
 * ones that want the user (or are running) first, then the latest ones. It is
 * the cross-project view the per-workspace rows above cannot give at a glance.
 */
export function RecentConversations({ onOpenNotification, onOpenChat, onNavigate }: RecentConversationsProps) {
  const entries = useActiveConversations()
  const openEntry = useOpenActiveEntry(onOpenNotification, onOpenChat)
  const locationOf = useLocationLabel()
  const { activeTabId, currentWorkspaceId } = useEditorStore(useShallow((s) => ({
    activeTabId: s.activeTabId,
    currentWorkspaceId: s.currentWorkspaceId,
  })))
  const onWorkbench = useNavigationStore((s) => s.main.kind === "workbench")

  if (entries.length === 0) return null

  const handleOpen = (entry: ActiveEntry) => {
    openEntry(entry)
    onNavigate?.()
  }

  return (
    <section data-testid="sidebar-recent" aria-labelledby="sidebar-recent-heading" className="px-2 pt-3">
      {/* Inset like the tree above: heading and icons line up with "Projects" and the folders. */}
      <div id="sidebar-recent-heading" className="heading-section flex h-7 items-center px-2">
        <FormattedMessage {...messages.recent} />
      </div>
      {entries.map((entry) => (
        <ActiveRow
          key={entry.key}
          entry={entry}
          location={locationOf(entry)}
          current={onWorkbench && entry.tab != null &&
            entry.tab.workspaceId === currentWorkspaceId && entry.tab.tabId === activeTabId}
          onOpen={handleOpen}
        />
      ))}
    </section>
  )
}

/**
 * Whose turn one conversation is, for its row in the tree: the same rules as
 * the Recent list, read per row as a primitive so a turn starting or ending
 * re-renders that row only.
 */
/** `nodeId`: the chat's machine (undefined: this one). */
export function useChatAttention(chatId: number, nodeId?: string): ActiveGroup | null {
  const ref = nodeId ? { nodeId, chatId } : localChat(chatId)
  const tabId = useEditorStore((s) => {
    const match = (tab: EditorTab) => tab.type === "chat" && !tab.isSideChat &&
      (nodeId ? sameChat(chatRefOfTab(tab) ?? chatRefFromTabId(tab.id), ref) : !tab.nodeId && chatIdOfTab(tab) === chatId)
    const current = s.tabs.find(match)
    if (current) return current.id
    for (const bucket of Object.values(s.workspaceStates)) {
      const found = bucket.tabs.find(match)
      if (found) return found.id
    }
    return null
  })
  const pending = useChatPendingInputStore((s) => s.pendingByChat.has(chatKey(ref)))
  const present = useChatRunningStore((s) => s.runningChats.has(chatKey(ref)))
  const streaming = useStreamingStore((s) => tabId != null && s.streamingTabIds.has(tabId))
  const unseen = useStreamingStore((s) => tabId != null && s.unseenTabIds.has(tabId))
  const { data: unread } = useInboxUnread()
  // The inbox is this machine's.
  const notification = nodeId ? undefined : unread?.find((n) => n.chatId === chatId && !isAssistantNotification(n))
  if (pending || notification?.severity === "action") return "needs"
  if (present || streaming) return "running"
  if (unseen || notification) return "done"
  return null
}

/** Whether a row is the conversation on screen: by chat id, else (a first turn) by its tab. */
function useIsCurrentEntry() {
  const { activeTabId, currentWorkspaceId, activeChatId } = useEditorStore(useShallow((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return {
      activeTabId: s.activeTabId,
      currentWorkspaceId: s.currentWorkspaceId,
      activeChatId: tab?.type === "chat" ? chatIdOfTab(tab) ?? null : null,
    }
  }))
  const onWorkbench = useNavigationStore((s) => s.main.kind === "workbench")
  return useCallback((entry: ActiveEntry) => onWorkbench && (entry.chatId != null
    ? entry.chatId === activeChatId
    : entry.tab != null && entry.tab.workspaceId === currentWorkspaceId && entry.tab.tabId === activeTabId),
  [onWorkbench, activeChatId, activeTabId, currentWorkspaceId])
}

type DayGroup = "today" | "yesterday" | "earlier"
const DAY_GROUPS: readonly DayGroup[] = ["today", "yesterday", "earlier"]

function dayGroupOf(at: number, now: Date): DayGroup {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (at >= startOfToday) return "today"
  if (at >= startOfToday - 24 * 60 * 60 * 1000) return "yesterday"
  return "earlier"
}

/** Same as the phone's Chats list, so the two never fight over one cache entry's page size. */
const FOCUS_PAGE_SIZE = 30

/**
 * The sidebar's Focus view, in place of the project tree: first everything
 * that wants the user (waiting on an answer, an unread reply, a running turn,
 * an unread board or device notice), then every conversation by day. It is
 * also where unread notices live now that there is no Inbox page: opening one
 * marks it read, which takes it off the list.
 */
export function FocusConversations({ onOpenNotification, onOpenChat, onNavigate }: RecentConversationsProps) {
  const intl = useIntl()
  const priority = useFocusPriority()
  const openEntry = useOpenActiveEntry(onOpenNotification, onOpenChat)
  const locationOf = useLocationLabel()
  const isCurrent = useIsCurrentEntry()
  const markRead = useInboxStore((s) => s.markRead)
  const { items, hasMore, isLoadingMore, loadMore } = useChatHistoryList({ workspaceId: undefined, tp: "chat", pageSize: FOCUS_PAGE_SIZE })

  const unreadIds = unreadNotificationIds(priority)
  // A string, so the grouping reruns when the set changes, not on every render.
  const priorityChats = priority.flatMap((entry) => entry.chatId != null ? [entry.chatId] : []).join(",")
  const byDay = useMemo(() => {
    const inPriority = new Set(priorityChats.split(",").filter(Boolean).map(Number))
    const now = new Date()
    const groups: Record<DayGroup, ActiveEntry[]> = { today: [], yesterday: [], earlier: [] }
    for (const chat of items) {
      if (inPriority.has(chat.id)) continue
      groups[dayGroupOf(chat.updatedAt, now)].push({
        key: `chat:${chat.id}`,
        group: "recent",
        chatId: chat.id,
        title: chat.title,
        providerId: chat.providerId,
        workspaceId: chat.workspaceId ?? null,
        projectId: null,
        at: chat.updatedAt,
      })
    }
    return groups
  }, [items, priorityChats])

  const handleOpen = (entry: ActiveEntry) => {
    openEntry(entry)
    onNavigate?.()
  }
  const row = (entry: ActiveEntry) => (
    <ActiveRow key={entry.key} entry={entry} location={locationOf(entry)} showLocation current={isCurrent(entry)} onOpen={handleOpen} />
  )
  const markAllReadLabel = intl.formatMessage(messages.markAllRead)

  return (
    <div data-testid="sidebar-focus" className="px-2">
      <section aria-labelledby="focus-priority-heading">
        <div className="flex h-7 items-center justify-between pl-2">
          <span id="focus-priority-heading" className="heading-section"><FormattedMessage {...messages.priority} /></span>
          {unreadIds.length > 0 && (
            <Tooltip delayDuration={600}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-testid="focus-mark-all-read"
                  aria-label={markAllReadLabel}
                  onClick={() => void markRead(unreadIds)}
                  className="mr-1 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <CheckCheck className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{markAllReadLabel}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {priority.length === 0
          ? <p className="px-2 py-1.5 text-xs text-muted-foreground"><FormattedMessage {...messages.nothingPending} /></p>
          : priority.map(row)}
      </section>
      {DAY_GROUPS.map((day) => byDay[day].length > 0 && (
        <section key={day} aria-labelledby={`focus-${day}-heading`} className="pt-3">
          <div id={`focus-${day}-heading`} className="heading-section flex h-7 items-center px-2">
            <FormattedMessage {...messages[day]} />
          </div>
          {byDay[day].map(row)}
        </section>
      ))}
      {hasMore && (
        <button
          type="button"
          disabled={isLoadingMore}
          onClick={loadMore}
          className="mt-1 flex h-7 w-full items-center rounded-lg px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        >
          <FormattedMessage {...messages.showMore} />
        </button>
      )}
    </div>
  )
}
