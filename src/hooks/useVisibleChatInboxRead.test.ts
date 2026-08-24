import { describe, expect, it } from "vitest"
import { shouldMarkVisibleChatRead } from "./useVisibleChatInboxRead"

describe("shouldMarkVisibleChatRead", () => {
  it("marks a persisted chat when its surface is visible and focused", () => {
    expect(
      shouldMarkVisibleChatRead({
        chatId: 42,
        surfaceVisible: true,
        documentVisible: true,
        windowFocused: true,
      }),
    ).toBe(true)
  })

  it.each<[string, number | undefined, boolean, boolean, boolean]>([
    ["unpersisted chat", undefined, true, true, true],
    ["background tab", 42, false, true, true],
    ["hidden document", 42, true, false, true],
    ["unfocused window", 42, true, true, false],
  ])(
    "keeps the notification unread for a %s",
    (_case, chatId, surfaceVisible, documentVisible, windowFocused) => {
      expect(
        shouldMarkVisibleChatRead({
          chatId,
          surfaceVisible,
          documentVisible,
          windowFocused,
        }),
      ).toBe(false)
    },
  )
})
