import { beforeEach, describe, expect, it, vi } from "vitest"
import type { InboxListPage } from "@/lib/api-client"
import type { Notification } from "@/types/notification"

const { inboxList, inboxMarkRead } = vi.hoisted(() => ({
  inboxList: vi.fn<() => Promise<InboxListPage>>(),
  inboxMarkRead: vi.fn().mockResolvedValue({ ids: [] }),
}))

vi.mock("@/lib/api", () => ({
  api: {
    inboxList,
    inboxMarkRead,
  },
}))

import { useInboxStore } from "./inbox-store"

function notification(id: number, severity: Notification["severity"] = "info"): Notification {
  return {
    id,
    kind: "chat_complete",
    severity,
    projectId: 1,
    workspaceId: 1,
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
  }
}

beforeEach(() => {
  inboxList.mockReset()
  inboxMarkRead.mockClear()
  useInboxStore.setState({
    items: [],
    counts: { total: 0, action: 0 },
    filter: "all",
    loading: false,
    loaded: false,
    loadingMore: false,
    hasMore: false,
    nextCursor: null,
  })
})

describe("assistant unread notifications", () => {
  it("keeps assistant counts from the initial stream snapshot without loading the inbox", () => {
    useInboxStore.getState().applyEvent({
      type: "counts", total: 0, action: 0, assistantTotal: 2, assistantAction: 1,
    })

    expect(useInboxStore.getState().counts).toEqual({
      total: 0, action: 0, assistantTotal: 2, assistantAction: 1,
    })
    expect(inboxList).not.toHaveBeenCalled()
  })

  it("does not mark the assistant read when marking the inbox read", async () => {
    const assistant: Notification = {
      ...notification(2), kind: "assistant_message", sourceKey: "assistant:message",
    }
    useInboxStore.setState({ items: [notification(1), assistant] })

    await useInboxStore.getState().markAllRead()

    expect(useInboxStore.getState().items[0].readAt).not.toBeNull()
    expect(useInboxStore.getState().items[1].readAt).toBeNull()
    expect(inboxMarkRead).toHaveBeenCalledWith({ all: true })
  })

  it("clears assistant counts after the assistant is read", () => {
    useInboxStore.getState().applyEvent({
      type: "counts", total: 1, action: 0, assistantTotal: 2, assistantAction: 1,
    })
    useInboxStore.getState().applyEvent({
      type: "counts", total: 1, action: 0, assistantTotal: 0, assistantAction: 0,
    })
    expect(useInboxStore.getState().counts).toEqual({
      total: 1, action: 0, assistantTotal: 0, assistantAction: 0,
    })
  })
})

describe("inbox pagination", () => {
  it("loads the first page, then appends a deduplicated cursor page", async () => {
    inboxList
      .mockResolvedValueOnce({
        notifications: [notification(5), notification(4)],
        hasMore: true,
        nextCursor: 4,
      })
      .mockResolvedValueOnce({
        notifications: [notification(4), notification(3)],
        hasMore: false,
      })

    await useInboxStore.getState().load()
    await useInboxStore.getState().loadMore()

    expect(inboxList.mock.calls).toEqual([
      [{ severity: undefined, limit: 50 }],
      [{ severity: undefined, cursor: 4, limit: 50 }],
    ])
    expect(useInboxStore.getState().items.map((item) => item.id)).toEqual([5, 4, 3])
    expect(useInboxStore.getState().hasMore).toBe(false)
    expect(useInboxStore.getState().nextCursor).toBeNull()
  })

  it("reloads the first server-filtered page when the filter changes", async () => {
    inboxList.mockResolvedValue({
      notifications: [notification(2, "action")],
      hasMore: false,
    })

    await useInboxStore.getState().setFilter("action")

    expect(inboxList).toHaveBeenCalledWith({ severity: "action", limit: 50 })
    expect(useInboxStore.getState().filter).toBe("action")
    expect(useInboxStore.getState().items.map((item) => item.id)).toEqual([2])
  })
})
