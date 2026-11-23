import type { ChannelUnread } from '../../types/channel.js'
import { registerChannelAttention } from '../channel-bus.js'
import { channelSessionsWaiting, waitingSessions, type ThreadStorage } from './threads.js'

/**
 * The "waiting on you" half of a channel's unread — the amber count. Unlike
 * unread it is not cleared by looking: an agent blocked on an approval or a
 * question stays counted until you answer. Computed, not stored: pending
 * approvals live in memory (chat-pending-input), thread status in
 * channel_threads.
 *
 *   - each channel session (scope 'app') with something pending       → 1
 *   - each thread session with something pending                       → 1
 *   - each thread reported `waiting` whose latest replies are unread   → 1
 *
 * The last is gated on unread so a "need your call" you have read and chosen
 * not to answer yet falls back to the thread's own "Needs input" label instead
 * of keeping the channel amber forever.
 */
export function channelAttention(storage: ThreadStorage, channelId: number, unread: ChannelUnread | null): number {
  let count = channelSessionsWaiting(storage, channelId).length
  const threads = storage.listThreads(channelId)
  if (threads.length === 0) return count
  // One read of the thread sessions, not one per thread: this runs on every agent message.
  const roots = new Set(threads.map((t) => String(t.rootMessageId)))
  const sessions = storage.listBindings({ scopeKind: 'thread' }).filter((b) => roots.has(b.scopeKey))
  const waiting = waitingSessions(sessions)
  count += waiting.length
  const blockedChats = new Set(waiting.map((w) => w.chatId))
  const blockedRoots = new Set(sessions.filter((b) => b.activeChatId != null && blockedChats.has(b.activeChatId)).map((b) => b.scopeKey))
  for (const thread of threads) {
    // A thread already counted for a blocked session isn't counted twice.
    if (blockedRoots.has(String(thread.rootMessageId))) continue
    if (thread.status === 'waiting' && (unread?.threads[thread.rootMessageId] ?? 0) > 0) count += 1
  }
  return count
}

/** One channel's unread with its attention count; null when the channel is gone. */
export function getChannelUnreadWithAttention(storage: ThreadStorage, channelId: number): ChannelUnread | null {
  const unread = storage.getChannelUnread(channelId)
  if (!unread) return null
  return { ...unread, attention: channelAttention(storage, channelId, unread) }
}

/**
 * Every channel with unread or attention. Attention is looked up only where it
 * can be non-zero: channels with a session that has a chat, and channels with
 * unread threads (for the `waiting` rule).
 */
export function listChannelUnreadWithAttention(storage: ThreadStorage): ChannelUnread[] {
  const byChannel = new Map(storage.listChannelUnread().map((u) => [u.channelId, u]))
  const candidates = new Set(byChannel.keys())
  for (const b of storage.listBindings({ scopeKind: 'app' })) {
    if (b.activeChatId != null) candidates.add(Number(b.scopeKey))
  }
  for (const b of storage.listBindings({ scopeKind: 'thread' })) {
    if (b.activeChatId == null) continue
    const channelId = storage.getThread(Number(b.scopeKey))?.channelId
    if (channelId != null) candidates.add(channelId)
  }
  const result: ChannelUnread[] = []
  for (const channelId of candidates) {
    const base = byChannel.get(channelId) ?? (storage.getChannel(channelId) ? { channelId, unread: 0, threads: {} } : null)
    if (!base) continue
    const attention = channelAttention(storage, channelId, base)
    if (attention > 0 || base.unread > 0 || Object.keys(base.threads).length > 0) result.push({ ...base, attention })
  }
  return result
}

/** Make every `channel_unread` the bus sends carry attention. Called once at orchestrator start. */
export function initChannelAttention(storage: ThreadStorage): void {
  registerChannelAttention((channelId, unread) => channelAttention(storage, channelId, unread))
}
