import { describe, expect, it } from "vitest"
import type { EditorTab } from "@/types/editor"
import type { Notification } from "@/types/notification"
import { activeAttentionCounts, buildActiveEntries, type ActiveInput, type RecentChat } from "./active-conversations"

const tab = (id: string, chatId?: number, extra: Partial<EditorTab> = {}): EditorTab => ({
  id,
  chatId,
  title: `Tab ${id}`,
  type: "chat",
  closable: true,
  providerId: "claude-code",
  ...extra,
})

const recent = (id: number, updatedAt = id, extra: Partial<RecentChat> = {}): RecentChat => ({
  id,
  title: `Chat ${id}`,
  updatedAt,
  workspaceId: 10,
  providerId: "codex",
  ...extra,
})

const notification = (id: number, overrides: Partial<Notification> = {}): Notification => ({
  id,
  kind: "chat_complete",
  severity: "info",
  projectId: 1,
  workspaceId: 10,
  chatId: id,
  taskId: null,
  agentId: null,
  title: `Notification ${id}`,
  body: null,
  sourceKey: `chat:${id}`,
  readAt: null,
  archivedAt: null,
  createdAt: id,
  updatedAt: id,
  ...overrides,
})

const input = (overrides: Partial<ActiveInput>): ActiveInput => ({
  buckets: [],
  recentChats: [],
  unread: [],
  pendingChatIds: new Set(),
  runningChatIds: new Set(),
  streamingTabIds: new Set(),
  unseenTabIds: new Set(),
  projectOfWorkspace: () => 1,
  ...overrides,
})

const summary = (entries: ReturnType<typeof buildActiveEntries>) => entries.map((e) => [e.key, e.group])

describe("buildActiveEntries", () => {
  it("groups conversations by whose turn it is, most urgent first", () => {
    const entries = buildActiveEntries(input({
      recentChats: [recent(5, 50), recent(4, 40), recent(3, 30), recent(2, 20), recent(1, 10)],
      buckets: [{ workspaceId: 10, tabs: [tab("chat:4", 4)] }],
      pendingChatIds: new Set([2]),
      runningChatIds: new Set([3]),
      unseenTabIds: new Set(["chat:4"]),
    }))

    expect(summary(entries)).toEqual([
      ["chat:2", "needs"],
      ["chat:4", "done"],
      ["chat:3", "running"],
      ["chat:5", "recent"],
      ["chat:1", "recent"],
    ])
  })

  it("keeps a conversation whose tab was closed, so it can be reopened", () => {
    const entries = buildActiveEntries(input({ recentChats: [recent(7)] }))

    expect(entries).toEqual([expect.objectContaining({ key: "chat:7", group: "recent", chatId: 7, tab: undefined, workspaceId: 10 })])
  })

  it("prefers an open tab's workspace, live title and agent", () => {
    const entries = buildActiveEntries(input({
      recentChats: [recent(7)],
      buckets: [{ workspaceId: 20, tabs: [tab("chat:local", 7, { title: "Renamed" })] }],
      projectOfWorkspace: (id) => (id === 20 ? 2 : null),
    }))

    expect(entries[0]).toMatchObject({
      tab: { workspaceId: 20, tabId: "chat:local" },
      title: "Renamed",
      providerId: "claude-code",
      workspaceId: 20,
      projectId: 2,
    })
  })

  it("counts a streaming tab as running before the server says so, including an unsaved new chat", () => {
    const entries = buildActiveEntries(input({
      recentChats: [recent(1)],
      buckets: [{ workspaceId: 10, tabs: [tab("chat:1", 1), tab("chat:new")] }],
      streamingTabIds: new Set(["chat:1", "chat:new"]),
    }))

    expect(summary(entries)).toEqual([["tab:chat:new", "running"], ["chat:1", "running"]])
  })

  it("uses unread inbox rows: an ask is needs, a reply is done, even with no tab or listing", () => {
    const entries = buildActiveEntries(input({
      recentChats: [recent(1)],
      unread: [
        notification(1),
        notification(2, { kind: "chat_needs_input", severity: "action" }),
      ],
    }))

    expect(summary(entries)).toEqual([["chat:2", "needs"], ["chat:1", "done"]])
    expect(entries[0]).toMatchObject({ title: "Notification 2", titleFromNotification: true })
    expect(entries[1]).toMatchObject({ title: "Chat 1", titleFromNotification: undefined })
  })

  it("lets an ask outrank a reply for the same chat", () => {
    const entries = buildActiveEntries(input({
      unread: [
        notification(30, { chatId: 9, sourceKey: "chat:9" }),
        notification(31, { chatId: 9, sourceKey: "chat:9", kind: "chat_needs_input", severity: "action" }),
        notification(32, { chatId: 9, sourceKey: "chat:9" }),
      ],
    }))

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ key: "chat:9", group: "needs" })
    expect(entries[0].notification?.id).toBe(31)
  })

  it("adds board items asking for the user, but not plain history", () => {
    const entries = buildActiveEntries(input({
      unread: [
        notification(6, { kind: "task_in_review", severity: "action", chatId: null, taskId: 3, sourceKey: "task:3" }),
        notification(7, { kind: "task_done", chatId: null, taskId: 4, sourceKey: "task:4" }),
        notification(8, { kind: "assistant_message", chatId: null, sourceKey: "assistant:8" }),
      ],
    }))

    expect(summary(entries)).toEqual([["notification:6", "needs"]])
  })

  it("skips running chats nothing names (a sub-agent), side chats, and caps Recent", () => {
    const entries = buildActiveEntries(input({
      recentChats: [recent(1, 1), recent(2, 2), recent(3, 3)],
      buckets: [{ workspaceId: 10, tabs: [tab("chat:99", 99, { isSideChat: true })] }],
      runningChatIds: new Set([50, 99]),
      recentLimit: 2,
    }))

    expect(summary(entries)).toEqual([["chat:3", "recent"], ["chat:2", "recent"]])
  })

  it("shows a chat open in two tabs once", () => {
    const entries = buildActiveEntries(input({
      recentChats: [recent(1)],
      buckets: [
        { workspaceId: 10, tabs: [tab("chat:local", 1)] },
        { workspaceId: 20, tabs: [tab("chat:1", 1)] },
      ],
    }))

    expect(entries.map((e) => e.tab)).toEqual([{ workspaceId: 10, tabId: "chat:local" }])
  })

  it("counts the rows that want the user", () => {
    const entries = buildActiveEntries(input({
      recentChats: [recent(1), recent(2), recent(3)],
      buckets: [{ workspaceId: 10, tabs: [tab("chat:2", 2)] }],
      pendingChatIds: new Set([1]),
      unseenTabIds: new Set(["chat:2"]),
      runningChatIds: new Set([3]),
    }))

    expect(activeAttentionCounts(entries)).toEqual({ needs: 1, done: 1 })
  })
})
