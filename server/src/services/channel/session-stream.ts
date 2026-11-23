/**
 * Which messages an agent session reads. An agent has one session per channel
 * (an 'app' binding) and one per thread it works in (a 'thread' binding):
 *
 *   channel stream — the main channel, plus replies in threads nobody owns yet
 *   thread stream  — the replies in that one thread
 *
 * Unread, read cursors and "what to call it in a prompt" all follow from the
 * stream, so every caller goes through here instead of reading binding.scopeKey.
 */

import type { AgentBindingStorageAdapter, ChannelStorageAdapter } from '../../storage/interface.js'
import type { AgentBinding } from '../../types/agent-binding.js'
import type { ChannelMessage } from '../../types/channel.js'
import { toShortId } from '../agent-comm/channel-message-format.js'

export type SessionStream =
  | { kind: 'channel'; channelId: number }
  | { kind: 'thread'; channelId: number; rootMessageId: number }

type StreamStorage = Pick<ChannelStorageAdapter, 'getThread' | 'getChannelMessage' | 'getUnreadChannelMessages' | 'getUnreadThreadMessages'>
  & Pick<AgentBindingStorageAdapter, 'upsertCursor'>

/** The stream a binding's session reads, or null for bindings that are not channel sessions (task, IM…). */
export function streamOfBinding(
  storage: Pick<ChannelStorageAdapter, 'getThread' | 'getChannelMessage'>,
  binding: Pick<AgentBinding, 'scopeKind' | 'scopeKey'>,
): SessionStream | null {
  const key = Number(binding.scopeKey)
  if (!Number.isFinite(key)) return null
  if (binding.scopeKind === 'app') return { kind: 'channel', channelId: key }
  if (binding.scopeKind === 'thread') {
    const channelId = storage.getThread(key)?.channelId ?? storage.getChannelMessage(key)?.channelId
    return channelId != null ? { kind: 'thread', channelId, rootMessageId: key } : null
  }
  return null
}

export function unreadIn(storage: StreamStorage, agentId: number, stream: SessionStream): ChannelMessage[] {
  return stream.kind === 'channel'
    ? storage.getUnreadChannelMessages(agentId, stream.channelId)
    : storage.getUnreadThreadMessages(agentId, stream.rootMessageId)
}

export function markReadIn(storage: StreamStorage, agentId: number, stream: SessionStream, lastId: number): void {
  if (stream.kind === 'channel') storage.upsertCursor(agentId, 'app', String(stream.channelId), lastId)
  else storage.upsertCursor(agentId, 'thread', String(stream.rootMessageId), lastId)
}

/** How a prompt or tool names the stream: '#general' or '#general:0000002a'. */
export function streamTarget(channelName: string, stream: SessionStream): string {
  return stream.kind === 'channel' ? `#${channelName}` : `#${channelName}:${toShortId(stream.rootMessageId)}`
}

/** The thread target for a root message. */
export function threadTarget(channelName: string, rootMessageId: number): string {
  return `#${channelName}:${toShortId(rootMessageId)}`
}
