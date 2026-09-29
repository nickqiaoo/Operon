import { api } from "@/lib/api"

/**
 * Tells the server which chats this window has in front of the user, so a turn
 * that finishes in one of them skips the inbox (they watched it finish). Every
 * visible ChatPanel registers here — split panes can show several at once — and
 * the union is reported only while the window is visible and focused.
 *
 * The server expires a report after ~75s, so while anything is on screen it is
 * re-sent on a heartbeat; a closed tab simply stops beating.
 */

const HEARTBEAT_MS = 30_000

const clientId =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`

const surfaces = new Map<symbol, number>()
let lastSent: number[] = []
let heartbeat: ReturnType<typeof setInterval> | null = null
let listening = false

function currentChatIds(): number[] {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return []
  return [...new Set(surfaces.values())].sort((a, b) => a - b)
}

function send(chatIds: number[]): void {
  api.inboxSetViewing({ clientId, chatIds }).catch(() => {
    // Best effort: a missed report only means one extra inbox row.
  })
}

function sync(): void {
  const chatIds = currentChatIds()
  if (chatIds.join(",") !== lastSent.join(",")) {
    lastSent = chatIds
    send(chatIds)
  }
  if (chatIds.length > 0 && heartbeat == null) {
    heartbeat = setInterval(() => send(lastSent), HEARTBEAT_MS)
  } else if (chatIds.length === 0 && heartbeat != null) {
    clearInterval(heartbeat)
    heartbeat = null
  }
}

function listen(): void {
  if (listening) return
  listening = true
  window.addEventListener("focus", sync)
  window.addEventListener("blur", sync)
  document.addEventListener("visibilitychange", sync)
}

/** Register a chat surface that is currently shown. Returns the unregister. */
export function registerViewedChat(chatId: number): () => void {
  listen()
  const key = Symbol("chat-surface")
  surfaces.set(key, chatId)
  sync()
  return () => {
    surfaces.delete(key)
    sync()
  }
}
