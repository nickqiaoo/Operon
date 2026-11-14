import { useCallback, useEffect, useMemo } from "react"
import { defineMessages, FormattedMessage, useIntl, type MessageDescriptor } from "react-intl"
import { useQueryClient } from "@tanstack/react-query"
import { Inbox, MessageSquare } from "lucide-react"
import { useShallow } from "zustand/react/shallow"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ProviderIcon } from "@/components/icons/ProviderLabel"
import { localizeNotification } from "@/components/inbox/localize-notification"
import { chatHistoryKeys, useRecentChats } from "@/lib/chat-queries"
import { formatRelativeTime } from "@/lib/format"
import { fileCitationsToText } from "@/lib/file-citation"
import { useInboxUnread } from "@/lib/inbox-queries"
import {
  ACTIVE_GROUPS,
  activeAttentionCounts,
  buildActiveEntries,
  type ActiveEntry,
  type ActiveGroup,
  type OpenChat,
} from "@/lib/active-conversations"
import { cn } from "@/lib/utils"
import { useChatPendingInputStore } from "@/stores/chat-pending-input-store"
import { useChatPresenceStore } from "@/stores/chat-presence-store"
import { useEditorStore } from "@/stores/editor-store"
import { useInboxStore } from "@/stores/inbox-store"
import { useNavigationStore } from "@/stores/navigation-store"
import { useProjectStore } from "@/stores/project-store"
import { useStreamingStore } from "@/stores/streaming-store"
import type { Notification } from "@/types/notification"

const messages = defineMessages({
  title: { id: "sidebar.active", defaultMessage: "Active" },
  inbox: { id: "sidebar.inbox", defaultMessage: "Inbox" },
  empty: { id: "active.empty", defaultMessage: "Nothing running or waiting on you" },
})

const groupLabels: Record<ActiveGroup, MessageDescriptor> = defineMessages({
  needs: { id: "active.group.needs", defaultMessage: "Needs you" },
  done: { id: "active.group.done", defaultMessage: "Done" },
  running: { id: "active.group.running", defaultMessage: "Running" },
  recent: { id: "active.group.recent", defaultMessage: "Recent" },
})

/** The Active rows, live. Subscribe in a leaf: it changes on every tab, turn and inbox event. */
export function useActiveConversations(): ActiveEntry[] {
  const { tabs, currentWorkspaceId, workspaceStates } = useEditorStore(useShallow((s) => ({
    tabs: s.tabs,
    currentWorkspaceId: s.currentWorkspaceId,
    workspaceStates: s.workspaceStates,
  })))
  const projects = useProjectStore((s) => s.projects)
  const pendingByChat = useChatPendingInputStore((s) => s.pendingByChat)
  const runningChatIds = useChatPresenceStore((s) => s.runningChatIds)
  const { streamingTabIds, unseenTabIds } = useStreamingStore(useShallow((s) => ({
    streamingTabIds: s.streamingTabIds,
    unseenTabIds: s.unseenTabIds,
  })))
  const { data: unread } = useInboxUnread()
  const { data: recentChats } = useRecentChats()

  // A turn starting or ending moves its chat to the top of the recent list.
  const queryClient = useQueryClient()
  const runningKey = useMemo(() => [...runningChatIds].sort((a, b) => a - b).join(","), [runningChatIds])
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: chatHistoryKeys.recent() })
  }, [queryClient, runningKey])

  return useMemo(() => {
    const currentKey = String(currentWorkspaceId ?? "global")
    const buckets = [
      { workspaceId: currentWorkspaceId, tabs },
      ...Object.entries(workspaceStates)
        .filter(([key]) => key !== currentKey)
        .map(([key, bucket]) => ({ workspaceId: key === "global" ? null : Number(key), tabs: bucket.tabs })),
    ]
    const projectByWorkspace = new Map<number, number>()
    for (const project of projects) for (const workspace of project.workspaces) projectByWorkspace.set(workspace.id, project.id)
    return buildActiveEntries({
      buckets,
      recentChats: recentChats ?? [],
      unread: unread ?? [],
      pendingChatIds: new Set(pendingByChat.keys()),
      runningChatIds,
      streamingTabIds,
      unseenTabIds,
      projectOfWorkspace: (workspaceId) => projectByWorkspace.get(workspaceId) ?? null,
    })
  }, [tabs, currentWorkspaceId, workspaceStates, projects, pendingByChat, runningChatIds, streamingTabIds, unseenTabIds, unread, recentChats])
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
function AgentIcon({ providerId, group }: { providerId?: string; group: ActiveGroup }) {
  const dot = STATUS_DOT[group]
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      {providerId
        ? <ProviderIcon id={providerId} size={14} />
        : <MessageSquare className="size-3.5 text-muted-foreground" strokeWidth={1.75} />}
      {dot && <span className={cn("absolute -bottom-0.5 -right-0.5 size-[7px] rounded-full ring-2 ring-sidebar", dot)} />}
    </span>
  )
}

function useLocationLabel() {
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
function ActiveRow({ entry, current, location, onOpen }: {
  entry: ActiveEntry
  current: boolean
  location: string
  onOpen: (entry: ActiveEntry) => void
}) {
  const intl = useIntl()
  const title = entry.titleFromNotification && entry.notification
    ? localizeNotification(entry.notification, intl).title
    : fileCitationsToText(entry.title)
  const wantsYou = entry.group === "needs" || entry.group === "done"
  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      aria-current={current ? "page" : undefined}
      title={location ? `${title}\n${location}` : title}
      className={cn(
        "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg pl-1 pr-2 text-left transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
        current && "bg-row-selected hover:bg-row-selected",
        entry.group === "running" && "animate-shimmer-sweep",
      )}
    >
      <AgentIcon providerId={entry.providerId} group={entry.group} />
      <span className={cn("min-w-0 flex-1 truncate text-sm", wantsYou ? "font-medium text-foreground" : "text-foreground/70")}>
        {title}
      </span>
      {wantsYou && entry.at > 0 && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
          {formatRelativeTime(intl, entry.at, { compact: true })}
        </span>
      )}
    </button>
  )
}

interface ActiveConversationsProps {
  onOpenNotification: (notification: Notification) => void
  onOpenChat: OpenChat
  /** After a row or the inbox link was used, e.g. to close the flyout holding the list. */
  onNavigate?: () => void
  /**
   * "section" (expanded sidebar): nothing at all while the list is empty.
   * "flyout" (collapsed rail): says it is empty, so the panel is never blank.
   */
  variant: "section" | "flyout"
  className?: string
}

/** The Active list: every conversation in play across projects, grouped by whose turn it is. */
export function ActiveConversations({ onOpenNotification, onOpenChat, onNavigate, variant, className }: ActiveConversationsProps) {
  const intl = useIntl()
  const entries = useActiveConversations()
  const openEntry = useOpenActiveEntry(onOpenNotification, onOpenChat)
  const locationOf = useLocationLabel()
  const { activeTabId, currentWorkspaceId } = useEditorStore(useShallow((s) => ({
    activeTabId: s.activeTabId,
    currentWorkspaceId: s.currentWorkspaceId,
  })))
  const onWorkbench = useNavigationStore((s) => s.main.kind === "workbench")

  if (variant === "section" && entries.length === 0) return null

  const handleOpen = (entry: ActiveEntry) => {
    openEntry(entry)
    onNavigate?.()
  }
  const openInbox = () => {
    useNavigationStore.getState().showMain({ kind: "inbox" })
    onNavigate?.()
  }
  const inboxLabel = intl.formatMessage(messages.inbox)

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex h-9 shrink-0 items-center justify-between px-4">
        <span className="heading-section"><FormattedMessage {...messages.title} /></span>
        <Tooltip delayDuration={600}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={inboxLabel}
              onClick={openInbox}
              className="mr-2 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Inbox className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{inboxLabel}</TooltipContent>
        </Tooltip>
      </div>
      {/* Inset like the project tree below, so the icons line up with its folders. */}
      <div className="code-scrollbar min-h-0 flex-1 overflow-y-auto scroll-fade-y px-4 pb-2">
        {entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground"><FormattedMessage {...messages.empty} /></p>
        ) : ACTIVE_GROUPS.map((group) => {
          const rows = entries.filter((entry) => entry.group === group)
          if (rows.length === 0) return null
          return (
            <div key={group} role="group" aria-label={intl.formatMessage(groupLabels[group])}>
              <div className="px-1 pb-0.5 pt-1 text-[11px] font-medium text-muted-foreground/70">
                <FormattedMessage {...groupLabels[group]} />
              </div>
              {rows.map((entry) => (
                <ActiveRow
                  key={entry.key}
                  entry={entry}
                  location={locationOf(entry)}
                  current={onWorkbench && entry.tab != null &&
                    entry.tab.workspaceId === currentWorkspaceId && entry.tab.tabId === activeTabId}
                  onOpen={handleOpen}
                />
              ))}
            </div>
          )
        })}
      </div>
      {/* Above the project tree, a hairline where the list ends. */}
      {variant === "section" && <div className="mx-4 mb-1 shrink-0 border-t border-border/40" />}
    </div>
  )
}
