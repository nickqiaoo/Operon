import { useCallback, useEffect } from "react"
import { useInboxStore } from "@/stores/inbox-store"
import { registerViewedChat } from "@/lib/viewed-chats-reporter"
import type { Notification } from "@/types/notification"

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

/** This chat's own row, or its task's "agent replied" row (which the chat shows). */
function isAboutChat(item: Notification, sourceKey: string, chatId: number | undefined): boolean {
  return item.sourceKey === sourceKey || (item.kind === "task_reply" && item.chatId === chatId)
}

/**
 * Keep Inbox read state aligned with what the user can actually see:
 * the active chat is read on activation/focus, and a new notification for an
 * already-visible chat is read as soon as its SSE upsert reaches the store.
 * The visible chat is also reported to the server, which then skips the
 * "finished responding" row for it altogether.
 */
export function useVisibleChatInboxRead(
  chatId: number | undefined,
  surfaceVisible: boolean,
): void {
  const sourceKey = chatId == null ? null : `chat:${chatId}`
  const markReadBySourceKeys = useInboxStore((state) => state.markReadBySourceKeys)
  const markRead = useInboxStore((state) => state.markRead)
  const unreadVersion = useInboxStore((state) => {
    if (!sourceKey) return null
    let latest: number | null = null
    for (const item of state.items) {
      if (item.readAt == null && isAboutChat(item, sourceKey, chatId)) latest = Math.max(latest ?? 0, item.updatedAt)
    }
    return latest
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
    // A task's agent replying in this session is read by seeing the reply here.
    const replies = useInboxStore.getState().items
      .filter((item) => item.readAt == null && item.kind === "task_reply" && item.chatId === chatId)
      .map((item) => item.id)
    if (replies.length > 0) void markRead(replies)
  }, [chatId, markRead, markReadBySourceKeys, surfaceVisible])

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

  // Report the chat as on screen so a turn finishing here never becomes a row.
  useEffect(() => {
    if (chatId == null || !surfaceVisible) return
    return registerViewedChat(chatId)
  }, [chatId, surfaceVisible])
}
