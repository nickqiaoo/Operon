import { EventEmitter } from 'node:events'
import type { AgentSessionStatus, ChannelMessage } from '../types/channel.js'
import type { TaskListItem } from '../types/task.js'
import type { Notification } from '../types/notification.js'

export type ChannelEvent =
  | { type: 'channel_message'; data: ChannelMessage }
  | { type: 'message_updated'; data: ChannelMessage }
  | { type: 'typing_start'; agentId: number }
  | { type: 'typing_stop'; agentId: number }

export type ProjectEvent = {
  type: 'agent_status'
  agentId: number
  projectId: number
  status: AgentSessionStatus
}

const bus = new EventEmitter()
bus.setMaxListeners(0)

export function emitChannelEvent(channelId: number, event: ChannelEvent): void {
  bus.emit(`channel:${channelId}`, event)
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
}

export function onTaskEvent(
  projectId: number,
  handler: (event: TaskEvent) => void
): () => void {
  const key = `tasks:${projectId}`
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
  | { type: 'counts'; total: number; action: number }

export function emitInboxEvent(event: InboxEvent): void {
  bus.emit('inbox', event)
}

export function onInboxEvent(handler: (event: InboxEvent) => void): () => void {
  bus.on('inbox', handler)
  return () => bus.off('inbox', handler)
}
