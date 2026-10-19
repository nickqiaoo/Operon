import { useCallback, useEffect } from "react"
import { useInboxStore } from "@/stores/inbox-store"
import { registerViewedAssistant } from "@/lib/viewed-chats-reporter"

/** Inbox rows the assistant raises: `assistant:message` and `assistant:approval:<id>`. */
const ASSISTANT_SOURCE_PREFIX = "assistant:"

/**
 * The assistant's counterpart to useVisibleChatInboxRead: while its thread is on screen
 * (surface shown, window visible and focused) the server is told so — what it says then
 * neither lands in the inbox nor buzzes a phone — and any of its rows already there are
 * read, which also cancels a push still held for when you leave the desk.
 *
 * Read by prefix on the server rather than from the loaded list: the inbox store only
 * fetches when its panel opens, so arriving here from a push (or any other entrance
 * that skips the inbox) would otherwise find nothing to mark.
 */
export function useVisibleAssistantInboxRead(surfaceVisible: boolean): void {
  const markReadBySourcePrefix = useInboxStore((state) => state.markReadBySourcePrefix)
  // A row raised while on screen (a permission card) arrives over SSE; re-run for it.
  const unreadVersion = useInboxStore((state) =>
    state.items
      .filter((item) => item.readAt == null && item.sourceKey.startsWith(ASSISTANT_SOURCE_PREFIX))
      .map((item) => `${item.id}:${item.updatedAt}`)
      .join(","),
  )

  const markIfVisible = useCallback(() => {
    if (!surfaceVisible) return
    if (document.visibilityState !== "visible" || !document.hasFocus()) return
    void markReadBySourcePrefix(ASSISTANT_SOURCE_PREFIX)
  }, [markReadBySourcePrefix, surfaceVisible])

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
    if (unreadVersion) markIfVisible()
  }, [markIfVisible, unreadVersion])

  useEffect(() => {
    if (!surfaceVisible) return
    return registerViewedAssistant()
  }, [surfaceVisible])
}
