import { describe, expect, it, vi } from "vitest"
import type { NotificationStorageAdapter } from "../storage/interface.js"
import type { Notification } from "../types/notification.js"
import { notificationRoutes } from "./notifications.js"

describe("GET /", () => {
  it("returns cursor metadata and requests one extra row", async () => {
    const rows = [{ id: 3 }, { id: 2 }, { id: 1 }] as Notification[]
    const notificationList = vi.fn(() => rows)
    const storage = {
      notificationList,
    } as unknown as NotificationStorageAdapter

    const response = await notificationRoutes(storage).request("/?limit=2")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      notifications: [{ id: 3 }, { id: 2 }],
      hasMore: true,
      nextCursor: 2,
    })
    expect(notificationList).toHaveBeenCalledWith({ limit: 3 })
  })

  it("omits the cursor when the final page is reached", async () => {
    const notificationList = vi.fn(() => [{ id: 1 }] as Notification[])
    const storage = {
      notificationList,
    } as unknown as NotificationStorageAdapter

    const response = await notificationRoutes(storage).request("/?cursor=2&limit=2")

    expect(await response.json()).toEqual({
      notifications: [{ id: 1 }],
      hasMore: false,
    })
    expect(notificationList).toHaveBeenCalledWith({ cursor: 2, limit: 3 })
  })
})

describe("POST /read", () => {
  it("marks deduplicated notification source keys and returns unique changed ids", async () => {
    const notificationMarkRead = vi.fn(() => [1])
    const notificationMarkReadBySource = vi.fn((sourceKey: string) =>
      sourceKey === "chat:42" ? [2, 1] : [],
    )
    const storage = {
      notificationMarkRead,
      notificationMarkReadBySource,
      notificationUnreadCounts: vi.fn(() => ({ total: 0, action: 0 })),
    } as unknown as NotificationStorageAdapter

    const response = await notificationRoutes(storage).request("/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [1],
        sourceKeys: ["chat:42", "chat:42", "", "chat:99"],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ids: [1, 2] })
    expect(notificationMarkRead).toHaveBeenCalledWith([1])
    expect(notificationMarkReadBySource.mock.calls).toEqual([["chat:42"], ["chat:99"]])
  })
})
