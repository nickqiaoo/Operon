import type { EditorTab } from "@/types/editor"
import type { Notification } from "@/types/notification"
import { isAssistantNotification } from "@/types/notification"

/**
 * The sidebar's Active list: one row per conversation in play, across every
 * project and workspace, grouped by whose turn it is.
 *
 * - `needs`: blocked on the user (an approval or question), or a board item asking for them.
 * - `done`: finished a turn the user has not looked at yet.
 * - `running`: mid-turn.
 * - `recent`: the latest conversations with activity, so getting back to one is one click.
 *
 * A conversation is the unit, not a tab: it can show here with no tab open (the
 * user closed it, or it was driven from the phone), and opening it brings the
 * tab back. A chat shows once, in its most urgent group.
 */
export type ActiveGroup = "needs" | "done" | "running" | "recent"

export const ACTIVE_GROUPS: readonly ActiveGroup[] = ["needs", "done", "running", "recent"]

/** App's `openChat`: focuses the chat's tab wherever it is, else opens one in its workspace. */
export type OpenChat = (target: { chatId: number; workspaceId?: number; title?: string }) => void

export interface RecentChat {
  id: number
  title: string
  updatedAt: number
  workspaceId?: number | null
  providerId?: string
}

export interface ActiveEntry {
  key: string
  group: ActiveGroup
  chatId?: number
  /** Where the chat's tab is open, if it is. The only way in for a tab whose chat is not saved yet. */
  tab?: { workspaceId: number | null; tabId: string }
  /** The unread inbox row behind this entry: the way in for a board item, which has no chat. */
  notification?: Notification
  title: string
  /** The title is a notification's (a server template the UI localizes), not the chat's own. */
  titleFromNotification?: boolean
  /** The agent the chat runs on, for its icon. Absent for board items and chats only an inbox row knows. */
  providerId?: string
  workspaceId: number | null
  projectId: number | null
  /** Orders a group: the latest activity known. */
  at: number
}

export interface ActiveInput {
  /** Every editor bucket, the current one with its live tabs. */
  buckets: ReadonlyArray<{ workspaceId: number | null; tabs: readonly EditorTab[] }>
  /** The user's conversations, most recently active first (server-side, so tabs need not be open). */
  recentChats: readonly RecentChat[]
  /** Unread inbox rows, any order. */
  unread: readonly Notification[]
  pendingChatIds: ReadonlySet<number>
  runningChatIds: ReadonlySet<number>
  streamingTabIds: ReadonlySet<string>
  unseenTabIds: ReadonlySet<string>
  projectOfWorkspace: (workspaceId: number) => number | null
  recentLimit?: number
}

const DEFAULT_RECENT_LIMIT = 6

const GROUP_RANK: Record<ActiveGroup, number> = { needs: 0, done: 1, running: 2, recent: 3 }

function chatIdOfTab(tab: EditorTab): number | undefined {
  if (tab.chatId != null) return tab.chatId
  const match = /^chat:(\d+)$/.exec(tab.id)
  return match ? Number(match[1]) : undefined
}

interface Candidate {
  chatId: number
  title?: string
  titleFromNotification?: boolean
  providerId?: string
  workspaceId?: number | null
  at: number
  tab?: { workspaceId: number | null; tabId: string }
  notification?: Notification
  inRecent: boolean
}

export function buildActiveEntries(input: ActiveInput): ActiveEntry[] {
  const projectOf = (workspaceId: number | null | undefined) =>
    workspaceId == null ? null : input.projectOfWorkspace(workspaceId)
  const candidates = new Map<number, Candidate>()
  const candidate = (chatId: number) => {
    let found = candidates.get(chatId)
    if (!found) {
      found = { chatId, at: 0, inRecent: false }
      candidates.set(chatId, found)
    }
    return found
  }
  const entries: ActiveEntry[] = []
  const runningChatIds = new Set(input.runningChatIds)
  const unseenChatIds = new Set<number>()

  input.recentChats.forEach((chat) => {
    const c = candidate(chat.id)
    c.title = chat.title
    c.providerId = chat.providerId
    c.workspaceId = chat.workspaceId ?? null
    c.at = Math.max(c.at, chat.updatedAt)
    c.inRecent = true
  })

  for (const bucket of input.buckets) {
    for (const tab of bucket.tabs) {
      if (tab.type !== "chat" || tab.isSideChat) continue
      const chatId = chatIdOfTab(tab)
      const streaming = input.streamingTabIds.has(tab.id)
      if (chatId == null) {
        // A new conversation's first turn, before the server has given it an id.
        if (streaming) {
          entries.push({
            key: `tab:${tab.id}`,
            group: "running",
            tab: { workspaceId: bucket.workspaceId, tabId: tab.id },
            title: tab.title,
            providerId: tab.providerId,
            workspaceId: bucket.workspaceId,
            projectId: projectOf(bucket.workspaceId),
            at: Number.MAX_SAFE_INTEGER,
          })
        }
        continue
      }
      const c = candidate(chatId)
      // The same chat open twice (an older build could do that) keeps the first tab.
      if (c.tab) continue
      c.tab = { workspaceId: bucket.workspaceId, tabId: tab.id }
      // The tab's bucket is where it is shown; its live title beats the listed one.
      c.workspaceId = bucket.workspaceId
      c.title = tab.title || c.title
      c.providerId = tab.providerId ?? c.providerId
      // The streaming store hears a mounted panel's turn before the server's presence frame.
      if (streaming) runningChatIds.add(chatId)
      if (input.unseenTabIds.has(tab.id)) unseenChatIds.add(chatId)
    }
  }

  for (const n of input.unread) {
    if (isAssistantNotification(n)) continue
    if (n.chatId == null) {
      // A board item asking for the user. Finished tasks and paired devices are
      // history, not work in progress: they stay in the inbox.
      if (n.severity !== "action") continue
      entries.push({
        key: `notification:${n.id}`,
        group: "needs",
        notification: n,
        title: n.title,
        titleFromNotification: true,
        workspaceId: n.workspaceId,
        projectId: n.projectId ?? projectOf(n.workspaceId),
        at: n.updatedAt,
      })
      continue
    }
    const c = candidate(n.chatId)
    // `needs` beats `done`; within a kind, the newest row speaks for the chat.
    const better = !c.notification ||
      (n.severity === "action" && c.notification.severity !== "action") ||
      (n.severity === c.notification.severity && n.updatedAt > c.notification.updatedAt)
    if (better) c.notification = n
    if (c.title === undefined) {
      c.title = n.title
      c.titleFromNotification = true
    }
    if (c.workspaceId === undefined) c.workspaceId = n.workspaceId
    c.at = Math.max(c.at, n.updatedAt)
  }

  const recent: ActiveEntry[] = []
  for (const c of candidates.values()) {
    const group: ActiveGroup | null =
      input.pendingChatIds.has(c.chatId) || c.notification?.severity === "action" ? "needs"
        : runningChatIds.has(c.chatId) ? "running"
        : unseenChatIds.has(c.chatId) || c.notification != null ? "done"
        : c.inRecent ? "recent"
        : null
    // Running or blocked chats nobody listed (a sub-agent, a teammate) have nothing to show them by.
    if (!group || c.title === undefined) continue
    const workspaceId = c.workspaceId ?? null
    const entry: ActiveEntry = {
      key: `chat:${c.chatId}`,
      group,
      chatId: c.chatId,
      tab: c.tab,
      notification: c.notification,
      title: c.title,
      titleFromNotification: c.titleFromNotification,
      providerId: c.providerId,
      workspaceId,
      projectId: c.notification?.projectId ?? projectOf(workspaceId),
      at: c.at,
    }
    if (group === "recent") recent.push(entry)
    else entries.push(entry)
  }

  entries.sort((a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group] || b.at - a.at)
  recent.sort((a, b) => b.at - a.at)
  return [...entries, ...recent.slice(0, input.recentLimit ?? DEFAULT_RECENT_LIMIT)]
}

/** How many rows want the user: the rail badge. */
export function activeAttentionCounts(entries: readonly ActiveEntry[]): { needs: number; done: number } {
  let needs = 0
  let done = 0
  for (const entry of entries) {
    if (entry.group === "needs") needs += 1
    else if (entry.group === "done") done += 1
  }
  return { needs, done }
}
