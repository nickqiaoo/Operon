import { createContext, useContext } from "react"

/**
 * A conversation shown here only as history — a finished Spec's session whose
 * worktree has been removed. Its panel replaces the composer with `reason`.
 * Set by the page around the chat surface; null everywhere else.
 */
export const ChatReadOnlyContext = createContext<{ chatId: number; reason: string } | null>(null)

/** The line to show in place of the composer, when `chatId` is the read-only one. */
export function useChatReadOnlyReason(chatId: number | null | undefined): string | null {
  const readOnly = useContext(ChatReadOnlyContext)
  return readOnly != null && chatId != null && readOnly.chatId === chatId ? readOnly.reason : null
}
