import type { BackgroundTaskSummary } from '@shared/background-tasks'
import type { PendingInputSummary } from '@shared/pending-input'
import { useChatBackgroundTaskStore } from '@/stores/chat-background-task-store'
import { useChatPendingInputStore } from '@/stores/chat-pending-input-store'
import { useChatPresenceStore } from '@/stores/chat-presence-store'
import { useChatPromptSuggestionStore } from '@/stores/chat-prompt-suggestion-store'
import { subscribeEvents } from './event-stream'
import { nodeKeyOf, type ChatRef, type NodeKey } from './chat-ref'
import type { SseSubscription } from './sse.js'

/**
 * One stream carrying turn presence for EVERY chat, fanned out to per-chat
 * listeners here.
 *
 * This used to be one SSE connection per open conversation, which filled
 * Chromium's 6-connections-per-host budget on the plain HTTP/1.1 local API and
 * queued every other request. It is now one channel of the app's shared event
 * stream (`lib/event-stream.ts`), for the same reason: Electron lifts the cap
 * (`ignore-connections-limit` in `electron/main.ts`), a plain browser cannot.
 *
 * The per-chat contract is preserved exactly, so callers did not have to change:
 * subscribing yields a status for that chat immediately, then one per turn
 * start/end.
 *
 * Per machine: this machine's stream is always the one the app shell watches;
 * another machine's opens while a tab shows one of its chats. Each keeps its own
 * subscribers and snapshot, and writes only its own chats into the stores.
 */

export interface LiveTurnStatus {
  chatId: number
  active: boolean
  turnId: string | null
  startedAt: number | null
}

type Frame =
  | {
      type: 'sync'
      statuses: LiveTurnStatus[]
      /** Absent from servers that predate pending input. */
      pendingInput?: Array<{ chatId: number; pending: PendingInputSummary[] }>
      /** Absent from servers that predate background tasks. */
      backgroundTasks?: Array<{ chatId: number; tasks: BackgroundTaskSummary[] }>
      /** Absent from servers that predate prompt suggestions. */
      promptSuggestions?: Array<{ chatId: number; text: string }>
    }
  | { type: 'presence'; status: LiveTurnStatus }
  /** A chat's whole pending list after any change; empty means nothing left. */
  | { type: 'pending-input'; chatId: number; pending: PendingInputSummary[] }
  /** A chat's whole background sub-agent list after any change. */
  | { type: 'background-tasks'; chatId: number; tasks: BackgroundTaskSummary[] }
  /** A chat's next-prompt guess; null once its next turn starts. */
  | { type: 'prompt-suggestion'; chatId: number; text: string | null }

interface Subscriber {
  onStatus: (status: LiveTurnStatus) => void
  onError?: () => void
}

interface NodeState {
  nodeId: string | undefined
  subscribers: Map<number, Set<Subscriber>>
  /**
   * Chats the server last reported as running a turn. Absence means idle, so a
   * chat subscribed later can be answered from here without asking the server —
   * that is what replaces the old per-connection snapshot.
   */
  activeByChat: Map<number, LiveTurnStatus>
  subscription: SseSubscription | null
  /** App-level watchers of pending input; they hold the stream open like chat subscribers do. */
  pendingInputWatchers: number
}

const nodes = new Map<NodeKey, NodeState>()

function nodeState(nodeId: string | undefined): NodeState {
  const key = nodeKeyOf(nodeId)
  let state = nodes.get(key)
  if (!state) {
    state = { nodeId, subscribers: new Map(), activeByChat: new Map(), subscription: null, pendingInputWatchers: 0 }
    nodes.set(key, state)
  }
  return state
}

const idleStatus = (chatId: number): LiveTurnStatus => ({
  chatId,
  active: false,
  turnId: null,
  startedAt: null,
})

function statusFor(node: NodeState, chatId: number): LiveTurnStatus {
  return node.activeByChat.get(chatId) ?? idleStatus(chatId)
}

function deliver(node: NodeState, status: LiveTurnStatus): void {
  const targets = node.subscribers.get(status.chatId)
  if (!targets) return
  for (const subscriber of targets) subscriber.onStatus(status)
}

function ensureStream(node: NodeState): void {
  if (node.subscription != null) return
  const key = nodeKeyOf(node.nodeId)
  const { nodeId } = node
  const ref = (chatId: number): ChatRef => (nodeId ? { nodeId, chatId } : { chatId })
  node.subscription = subscribeEvents<Frame>('live-status', {
    onEvent: (frame) => {
      if (frame.type === 'sync') {
        useChatPendingInputStore.getState().sync(key, frame.pendingInput ?? [])
        useChatBackgroundTaskStore.getState().sync(key, frame.backgroundTasks ?? [])
        useChatPromptSuggestionStore.getState().sync(key, frame.promptSuggestions ?? [])
        const next = new Map<number, LiveTurnStatus>()
        for (const status of frame.statuses) next.set(status.chatId, status)
        const previous = node.activeByChat
        node.activeByChat = next
        useChatPresenceStore.getState().sync(key, next.keys())
        // A reconnect's sync is also the recovery path: tell every subscriber
        // where its chat stands now, including the ones whose turn ended while
        // the stream was down (present before, absent now → idle).
        const touched = new Set<number>([...previous.keys(), ...next.keys(), ...node.subscribers.keys()])
        for (const chatId of touched) deliver(node, statusFor(node, chatId))
        return
      }
      if (frame.type === 'pending-input') {
        useChatPendingInputStore.getState().set(ref(frame.chatId), frame.pending)
        return
      }
      if (frame.type === 'background-tasks') {
        useChatBackgroundTaskStore.getState().set(ref(frame.chatId), frame.tasks)
        return
      }
      if (frame.type === 'prompt-suggestion') {
        useChatPromptSuggestionStore.getState().set(ref(frame.chatId), frame.text)
        return
      }
      if (frame.type !== 'presence') return
      const { status } = frame
      if (status.active) node.activeByChat.set(status.chatId, status)
      else node.activeByChat.delete(status.chatId)
      useChatPresenceStore.getState().set(ref(status.chatId), status.active)
      deliver(node, status)
    },
    onError: () => {
      for (const targets of node.subscribers.values()) {
        for (const subscriber of targets) subscriber.onError?.()
      }
    },
  }, nodeId)
}

function releaseStream(node: NodeState): void {
  if (node.subscribers.size > 0 || node.pendingInputWatchers > 0) return
  node.subscription?.close()
  node.subscription = null
  // Nothing is listening, so this view is about to go stale; the next connect
  // sends a fresh sync anyway.
  node.activeByChat = new Map()
  const key = nodeKeyOf(node.nodeId)
  useChatPresenceStore.getState().sync(key, [])
  useChatPendingInputStore.getState().sync(key, [])
  useChatBackgroundTaskStore.getState().sync(key, [])
  useChatPromptSuggestionStore.getState().sync(key, [])
  if (node.nodeId) nodes.delete(key)
}

/**
 * Keep `useChatPendingInputStore` and `useChatPresenceStore` current for every
 * chat of one machine (`nodeId` undefined: this one) — tab markers,
 * external-agent cards and the sidebar's Active list read them, including for
 * chats no panel is showing. Returns a release.
 */
export function watchPendingInput(nodeId?: string): () => void {
  const node = nodeState(nodeId)
  node.pendingInputWatchers += 1
  ensureStream(node)
  let released = false
  return () => {
    if (released) return
    released = true
    node.pendingInputWatchers -= 1
    releaseStream(node)
  }
}

/**
 * Watch one chat's live-turn presence. Returns an unsubscribe.
 *
 * `onStatus` fires once synchronously with the current state — matching the
 * snapshot the old per-chat stream sent on connect — and then on every change.
 */
export function subscribeChatPresence(chat: ChatRef, subscriber: Subscriber): () => void {
  const node = nodeState(chat.nodeId)
  const { chatId } = chat
  let targets = node.subscribers.get(chatId)
  if (!targets) {
    targets = new Set()
    node.subscribers.set(chatId, targets)
  }
  targets.add(subscriber)
  ensureStream(node)
  subscriber.onStatus(statusFor(node, chatId))

  return () => {
    const current = node.subscribers.get(chatId)
    if (!current) return
    current.delete(subscriber)
    if (current.size === 0) node.subscribers.delete(chatId)
    releaseStream(node)
  }
}
