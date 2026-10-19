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
/** The assistant's thread is not a chat row, so it is reported as a flag beside the ids. */
const assistantSurfaces = new Set<symbol>()
let lastSent: number[] = []
let lastSentAssistant = false
let heartbeat: ReturnType<typeof setInterval> | null = null
let listening = false

function onScreen(): boolean {
  return document.visibilityState === "visible" && document.hasFocus()
}

function currentChatIds(): number[] {
  if (!onScreen()) return []
  return [...new Set(surfaces.values())].sort((a, b) => a - b)
}

function currentAssistant(): boolean {
  return onScreen() && assistantSurfaces.size > 0
}

function send(chatIds: number[], assistant: boolean): void {
  api.inboxSetViewing({ clientId, chatIds, assistant }).catch(() => {
    // Best effort: a missed report only means one extra inbox row.
  })
}

function sync(): void {
  const chatIds = currentChatIds()
  const assistant = currentAssistant()
  if (chatIds.join(",") !== lastSent.join(",") || assistant !== lastSentAssistant) {
    lastSent = chatIds
    lastSentAssistant = assistant
    send(chatIds, assistant)
  }
  const anything = chatIds.length > 0 || assistant
  if (anything && heartbeat == null) {
    heartbeat = setInterval(() => send(lastSent, lastSentAssistant), HEARTBEAT_MS)
  } else if (!anything && heartbeat != null) {
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

/**
 * Register the assistant's thread as shown, so what it says while you read it does not also
 * land in the inbox or buzz your phone. Returns the unregister.
 */
export function registerViewedAssistant(): () => void {
  listen()
  const key = Symbol("assistant-surface")
  assistantSurfaces.add(key)
  sync()
  return () => {
    assistantSurfaces.delete(key)
    sync()
  }
}
