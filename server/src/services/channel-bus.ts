import { EventEmitter } from 'node:events'
import type { AgentSessionStatus, ChannelMessage, ChannelThreadView, ChannelUnread, WaitingSession } from '../types/channel.js'
import type { TaskListItem } from '../types/task.js'
import type { Notification, UnreadCounts } from '../types/notification.js'
import type { ChannelStorageAdapter } from '../storage/interface.js'
import type { AgentBinding } from '../types/agent-binding.js'

export type ChannelEvent =
  | { type: 'channel_message'; data: ChannelMessage; threadRoot?: Pick<ChannelMessage, 'id' | 'replyCount' | 'lastReplyAt'> }
  | { type: 'message_updated'; data: ChannelMessage }
  /** A thread's owner, reported status/summary or running sessions changed. */
  | { type: 'thread_updated'; data: ChannelThreadView }
  /** The channel sessions (not threads) waiting on a person changed; the full current list. */
  | { type: 'sessions_waiting'; data: WaitingSession[] }
  /** Which members' channel sessions (not threads) are running a turn changed; the full current list. */
  | { type: 'sessions_working'; agentIds: number[] }
  | { type: 'typing_start'; agentId: number }
  | { type: 'typing_stop'; agentId: number }

export type ProjectEvent = {
  type: 'agent_status'
  agentId: number
  projectId: number
  status: AgentSessionStatus
}

/** The agents running a turn, out of one channel's channel sessions ('app' bindings). */
export function workingAgentIds(sessions: Array<Pick<AgentBinding, 'agentId' | 'status'>>): number[] {
  return sessions.filter((b) => b.status === 'active').map((b) => b.agentId)
}

const bus = new EventEmitter()
bus.setMaxListeners(0)

export function emitChannelEvent(channelId: number, event: ChannelEvent): void {
  bus.emit(`channel:${channelId}`, event)
}

/**
 * Include the saved root so POST responses and stream events agree on the reply count.
 * An agent's message is unread for the person: the channel's new counts go out on
 * the (always-open) inbox stream, so the sidebar updates for channels not on screen.
 */
export function publishChannelMessage(storage: Pick<ChannelStorageAdapter, 'getChannelMessage' | 'getChannelUnread'>, message: ChannelMessage) {
  const root = message.threadRootId == null ? null : storage.getChannelMessage(message.threadRootId)
  const threadRoot = root ? { id: root.id, replyCount: root.replyCount, lastReplyAt: root.lastReplyAt } : undefined
  const payload = { message, ...(threadRoot ? { threadRoot } : {}) }
  emitChannelEvent(message.channelId, { type: 'channel_message', data: message, ...(threadRoot ? { threadRoot } : {}) })
  if (message.senderType === 'agent') publishChannelUnread(storage, message.channelId)
  return payload
}

type ChannelAttention = (channelId: number, unread: ChannelUnread) => number
let channelAttention: ChannelAttention | null = null

/**
 * The channel service's "waiting on you" count (channel-attention.ts). Registered
 * rather than imported: that module needs the thread helpers, which import this one.
 */
export function registerChannelAttention(fn: ChannelAttention): void {
  channelAttention = fn
}

/**
 * Send one channel's current unread to every client: after a new message or a
 * read, an approval appearing or answered, or a thread's status changing.
 */
export function publishChannelUnread(storage: Pick<ChannelStorageAdapter, 'getChannelUnread'>, channelId: number): void {
  const unread = storage.getChannelUnread(channelId)
  if (!unread) return
  emitInboxEvent({ type: 'channel_unread', unread: channelAttention ? { ...unread, attention: channelAttention(channelId, unread) } : unread })
}

export function onChannelEvent(
  channelId: number,
  handler: (event: ChannelEvent) => void
): () => void {
  const key = `channel:${channelId}`
  bus.on(key, handler)
  return () => bus.off(key, handler)
}

export function emitProjectEvent(projectId: number, event: ProjectEvent): void {
  bus.emit(`project:${projectId}`, event)
}

export function onProjectEvent(
  projectId: number,
  handler: (event: ProjectEvent) => void
): () => void {
  const key = `project:${projectId}`
  bus.on(key, handler)
  return () => bus.off(key, handler)
}

// ---- Project-level task events (live board / activity feed echo) ----
// Kept on a separate `tasks:` key so the channel stream doesn't receive them.

export type TaskEvent = { type: 'task_upsert'; task: TaskListItem }

export function emitTaskEvent(projectId: number, event: TaskEvent): void {
  bus.emit(`tasks:${projectId}`, event)
  // The global board watches every project at once.
  bus.emit('tasks:*', event)
}

/** `projectId: null` subscribes to every project's tasks. */
export function onTaskEvent(
  projectId: number | null,
  handler: (event: TaskEvent) => void
): () => void {
  const key = projectId == null ? 'tasks:*' : `tasks:${projectId}`
  bus.on(key, handler)
  return () => bus.off(key, handler)
}

// ---- User notification inbox (global, single-user instance) ----
// Not project-scoped: the inbox aggregates across every project/workspace, so
// it rides a single `inbox` key.

export type InboxEvent =
  | { type: 'notification_upsert'; notification: Notification }
  | { type: 'notification_read'; ids: number[] }
  | { type: 'notification_archive'; ids: number[] }
  | ({ type: 'counts' } & UnreadCounts)
  /** One channel's unread for the person changed (a new agent message, or read elsewhere). */
  | { type: 'channel_unread'; unread: ChannelUnread }

export function emitInboxEvent(event: InboxEvent): void {
  bus.emit('inbox', event)
}

export function onInboxEvent(handler: (event: InboxEvent) => void): () => void {
  bus.on('inbox', handler)
  return () => bus.off('inbox', handler)
}
