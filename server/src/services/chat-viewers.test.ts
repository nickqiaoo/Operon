import { afterEach, describe, expect, it, vi } from "vitest"
import type { NotificationStorageAdapter } from "../storage/interface.js"
import {
  CHAT_VIEWER_TTL_MS,
  isChatBeingViewed,
  resetChatViewers,
  setViewedChats,
} from "./chat-viewers.js"
import { notify } from "./notification-service.js"

afterEach(() => resetChatViewers())

describe("chat viewers", () => {
  it("tracks the union of what every client has on screen", () => {
    setViewedChats("desktop", [1, 2], 0)
    setViewedChats("phone", [3], 0)
    expect(isChatBeingViewed(2, 1)).toBe(true)
    expect(isChatBeingViewed(3, 1)).toBe(true)
    expect(isChatBeingViewed(4, 1)).toBe(false)
  })

  it("clears a client on an empty report", () => {
    setViewedChats("desktop", [1], 0)
    setViewedChats("desktop", [], 1)
    expect(isChatBeingViewed(1, 2)).toBe(false)
  })

  it("expires a client that stopped reporting", () => {
    setViewedChats("desktop", [1], 0)
    expect(isChatBeingViewed(1, CHAT_VIEWER_TTL_MS - 1)).toBe(true)
    expect(isChatBeingViewed(1, CHAT_VIEWER_TTL_MS)).toBe(false)
  })
})

describe("notify", () => {
  function storage() {
    return {
      notificationUpsert: vi.fn((input) => ({ id: 1, ...input })),
      notificationUnreadCounts: vi.fn(() => ({ total: 1, action: 0 })),
    } as unknown as NotificationStorageAdapter & {
      notificationUpsert: ReturnType<typeof vi.fn>
    }
  }

  const finished = {
    kind: "chat_complete" as const,
    severity: "info" as const,
    sourceKey: "chat:7",
    chatId: 7,
    title: "Chat",
  }

  it("skips chat_complete for a chat the user is watching", () => {
    setViewedChats("desktop", [7])
    const s = storage()
    notify(s, finished)
    expect(s.notificationUpsert).not.toHaveBeenCalled()
  })

  it("records chat_complete for a chat nobody is watching", () => {
    setViewedChats("desktop", [8])
    const s = storage()
    notify(s, finished)
    expect(s.notificationUpsert).toHaveBeenCalledOnce()
  })

  it("still records needs-input for a watched chat", () => {
    setViewedChats("desktop", [7])
    const s = storage()
    notify(s, { ...finished, kind: "chat_needs_input", severity: "action", push: false })
    expect(s.notificationUpsert).toHaveBeenCalledOnce()
  })
})
