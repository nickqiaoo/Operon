import { useCallback, useEffect } from "react"
import { useInboxStore } from "@/stores/inbox-store"

interface VisibleChatReadState {
  chatId: number | undefined
  surfaceVisible: boolean
  documentVisible: boolean
  windowFocused: boolean
}

export function shouldMarkVisibleChatRead({
  chatId,
  surfaceVisible,
  documentVisible,
  windowFocused,
}: VisibleChatReadState): boolean {
  return chatId != null && surfaceVisible && documentVisible && windowFocused
}

/**
 * Keep Inbox read state aligned with what the user can actually see:
 * the active chat is read on activation/focus, and a new notification for an
 * already-visible chat is read as soon as its SSE upsert reaches the store.
 */
export function useVisibleChatInboxRead(
  chatId: number | undefined,
  surfaceVisible: boolean,
): void {
  const sourceKey = chatId == null ? null : `chat:${chatId}`
  const markReadBySourceKeys = useInboxStore((state) => state.markReadBySourceKeys)
  const unreadVersion = useInboxStore((state) => {
    if (!sourceKey) return null
    const notification = state.items.find(
      (item) => item.sourceKey === sourceKey && item.readAt == null,
    )
    return notification?.updatedAt ?? null
  })

  const markIfVisible = useCallback(() => {
    if (
      !shouldMarkVisibleChatRead({
        chatId,
        surfaceVisible,
        documentVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
      })
    ) {
      return
    }
    void markReadBySourceKeys([`chat:${chatId}`])
  }, [chatId, markReadBySourceKeys, surfaceVisible])

  useEffect(() => {
    markIfVisible()
    window.addEventListener("focus", markIfVisible)
    document.addEventListener("visibilitychange", markIfVisible)
    return () => {
      window.removeEventListener("focus", markIfVisible)
      document.removeEventListener("visibilitychange", markIfVisible)
    }
  }, [markIfVisible])

  useEffect(() => {
    if (unreadVersion != null) markIfVisible()
  }, [markIfVisible, unreadVersion])
}
