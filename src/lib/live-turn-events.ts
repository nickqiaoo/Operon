import { api } from './api'
import { subscribeSse, type SseSubscription } from './sse.js'

/**
 * One stream carrying turn presence for EVERY chat, fanned out to per-chat
 * listeners here.
 *
 * This used to be one SSE connection per open conversation. The desktop renderer
 * reaches the local server at `http://127.0.0.1:<port>/api` over plain HTTP/1.1,
 * where Chromium allows 6 sockets per origin and never multiplexes, and a stream
 * that stays open holds one for its whole life. Three global streams plus three
 * chat tabs filled the pool; after that every request — sending a message
 * included — sat queued behind connections that never close, so the app looked
 * frozen rather than slow. Presence was the only one of those that grew with
 * use, which is why it is the one that got merged.
 *
 * The per-chat contract is preserved exactly, so callers did not have to change:
 * subscribing yields a status for that chat immediately, then one per turn
 * start/end.
 */

export interface LiveTurnStatus {
  chatId: number
  active: boolean
  turnId: string | null
  startedAt: number | null
}

type Frame =
  | { type: 'sync'; statuses: LiveTurnStatus[] }
  | { type: 'presence'; status: LiveTurnStatus }

interface Subscriber {
  onStatus: (status: LiveTurnStatus) => void
  onError?: () => void
}

const subscribers = new Map<number, Set<Subscriber>>()

/**
 * Chats the server last reported as running a turn. Absence means idle, so a
 * chat subscribed later can be answered from here without asking the server —
 * that is what replaces the old per-connection snapshot.
 */
let activeByChat = new Map<number, LiveTurnStatus>()

let subscription: SseSubscription | null = null

const idleStatus = (chatId: number): LiveTurnStatus => ({
  chatId,
  active: false,
  turnId: null,
  startedAt: null,
})

function statusFor(chatId: number): LiveTurnStatus {
  return activeByChat.get(chatId) ?? idleStatus(chatId)
}

function deliver(status: LiveTurnStatus): void {
  const targets = subscribers.get(status.chatId)
  if (!targets) return
  for (const subscriber of targets) subscriber.onStatus(status)
}

function ensureStream(): void {
  if (subscription != null) return
  subscription = subscribeSse<Frame>({
    url: () => api.aiLiveStatusStreamUrl(),
    onEvent: (frame) => {
      if (frame.type === 'sync') {
        const next = new Map<number, LiveTurnStatus>()
        for (const status of frame.statuses) next.set(status.chatId, status)
        const previous = activeByChat
        activeByChat = next
        // A reconnect's sync is also the recovery path: tell every subscriber
        // where its chat stands now, including the ones whose turn ended while
        // the stream was down (present before, absent now → idle).
        const touched = new Set<number>([...previous.keys(), ...next.keys(), ...subscribers.keys()])
        for (const chatId of touched) deliver(statusFor(chatId))
        return
      }
      if (frame.type !== 'presence') return
      const { status } = frame
      if (status.active) activeByChat.set(status.chatId, status)
      else activeByChat.delete(status.chatId)
      deliver(status)
    },
    onError: () => {
      for (const targets of subscribers.values()) {
        for (const subscriber of targets) subscriber.onError?.()
      }
    },
  })
}

function releaseStream(): void {
  if (subscribers.size > 0) return
  subscription?.close()
  subscription = null
  // Nothing is listening, so this view is about to go stale; the next connect
  // sends a fresh sync anyway.
  activeByChat = new Map()
}

/**
 * Watch one chat's live-turn presence. Returns an unsubscribe.
 *
 * `onStatus` fires once synchronously with the current state — matching the
 * snapshot the old per-chat stream sent on connect — and then on every change.
 */
export function subscribeChatPresence(chatId: number, subscriber: Subscriber): () => void {
  let targets = subscribers.get(chatId)
  if (!targets) {
    targets = new Set()
    subscribers.set(chatId, targets)
  }
  targets.add(subscriber)
  ensureStream()
  subscriber.onStatus(statusFor(chatId))

  return () => {
    const current = subscribers.get(chatId)
    if (!current) return
    current.delete(subscriber)
    if (current.size === 0) subscribers.delete(chatId)
    releaseStream()
  }
}
