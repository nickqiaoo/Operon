// Which chats is the user looking at right now?
//
// Each client (desktop window, web tab, phone) reports the chats it has on
// screen — surface visible, document visible, window focused — and re-reports
// on a heartbeat while that set is non-empty. A turn that finishes in a chat the
// user is watching needs no inbox row: they saw it happen. Without this every
// turn of every conversation landed in the inbox, including the one being read.
//
// The report expires on its own so a client that vanished without saying so (a
// closed tab, a dropped tunnel) cannot keep a chat "watched" forever.

/** Clients re-report every 30s; two missed beats and the report is stale. */
export const CHAT_VIEWER_TTL_MS = 75_000

interface ViewerReport {
  chatIds: Set<number>
  /** The assistant's thread is on screen (it is one conversation, but not a chat row). */
  assistant: boolean
  expiresAt: number
}

const viewers = new Map<string, ViewerReport>()

/** Replace what `clientId` has on screen. An empty list clears it. */
export function setViewedChats(clientId: string, chatIds: readonly number[], now = Date.now(), assistant = false): void {
  if (chatIds.length === 0 && !assistant) {
    viewers.delete(clientId)
    return
  }
  viewers.set(clientId, { chatIds: new Set(chatIds), assistant, expiresAt: now + CHAT_VIEWER_TTL_MS })
}

/** True when some live client currently has `chatId` on screen and focused. */
export function isChatBeingViewed(chatId: number, now = Date.now()): boolean {
  for (const [clientId, report] of viewers) {
    if (report.expiresAt <= now) {
      viewers.delete(clientId)
      continue
    }
    if (report.chatIds.has(chatId)) return true
  }
  return false
}

/** True when some live client currently has the assistant's thread on screen and focused. */
export function isAssistantBeingViewed(now = Date.now()): boolean {
  for (const [clientId, report] of viewers) {
    if (report.expiresAt <= now) {
      viewers.delete(clientId)
      continue
    }
    if (report.assistant) return true
  }
  return false
}

/** Test hook. */
export function resetChatViewers(): void {
  viewers.clear()
}
