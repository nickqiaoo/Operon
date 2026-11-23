/**
 * Turn-taking for channel group chats. Agents *pull* messages: the read cursor
 * advances only when message content is handed to the agent (`check_messages`,
 * or a held `send_message`), so the cursor is exactly "what this agent has
 * seen". Everything pushed into a running session is a nudge, never content.
 *
 *  - `nudgeActivePeers` — an agent posted: tell every *running* peer session
 *    in the channel that new messages are waiting (steer only, debounced).
 *    Idle peers are not woken; they see it on their next wake.
 *  - `selectHeldMessages` — send_message's soft gate: if others posted since
 *    the sender last read, return those instead of posting.
 *  - `planRewake` — on turn end, re-wake for unread human messages, but only a
 *    bounded number of times for agent-only messages. The count lives in the
 *    binding's metadata so a restart doesn't reset it.
 */

import type { AgentBindingStorageAdapter, ChannelStorageAdapter } from '../../storage/interface.js'
import type { AgentBinding } from '../../types/agent-binding.js'
import type { ChannelMessage } from '../../types/channel.js'
import { injectIntoChat } from '../ai.js'
import { cancelDebounce, debounceNotify } from './debounce-manager.js'
import { streamOfBinding, streamTarget, unreadIn } from './session-stream.js'

/** Agent-only follow-up wakes allowed before a human speaks again. */
export const MAX_AGENT_FOLLOW_UPS = 2

const PEER_NUDGE_DEBOUNCE_MS = 3000
const FOLLOW_UPS_KEY = 'peerFollowUps'

// ---- send_message soft gate ----

/**
 * Messages that should hold the agent's send. `unread` already excludes the
 * agent's own messages. System notices alone never hold a send; when something
 * else does, they are shown alongside it.
 */
export function selectHeldMessages(unread: ChannelMessage[]): ChannelMessage[] {
  return unread.some((m) => m.senderType !== 'system') ? unread : []
}

// ---- Turn-end re-wake planning ----

export type RewakePlan =
  | { kind: 'wake'; followUp: number }
  | { kind: 'skip'; reason: 'nothing-new' | 'follow-up-limit' }

/**
 * Decide whether a finished turn should be followed by another one.
 * `followUp` is 0 for a wake caused by a human message, N for the Nth
 * consecutive wake caused only by other agents' messages.
 */
export function planRewake(unread: ChannelMessage[], priorFollowUps: number, maxFollowUps = MAX_AGENT_FOLLOW_UPS): RewakePlan {
  if (unread.some((m) => m.senderType === 'human')) return { kind: 'wake', followUp: 0 }
  if (!unread.some((m) => m.senderType === 'agent')) return { kind: 'skip', reason: 'nothing-new' }
  const followUp = priorFollowUps + 1
  if (followUp > maxFollowUps) return { kind: 'skip', reason: 'follow-up-limit' }
  return { kind: 'wake', followUp }
}

type FollowUpStorage = Pick<AgentBindingStorageAdapter, 'getBinding' | 'updateBinding'>

export function readFollowUps(binding: Pick<AgentBinding, 'metadata'> | null | undefined): number {
  const n = binding?.metadata?.[FOLLOW_UPS_KEY]
  return typeof n === 'number' && n > 0 ? n : 0
}

export function getFollowUps(storage: FollowUpStorage, bindingId: number): number {
  return readFollowUps(storage.getBinding(bindingId))
}

export function setFollowUps(storage: FollowUpStorage, bindingId: number, n: number): void {
  const binding = storage.getBinding(bindingId)
  if (!binding || readFollowUps(binding) === Math.max(n, 0)) return
  const metadata = { ...(binding.metadata ?? {}) }
  if (n > 0) metadata[FOLLOW_UPS_KEY] = n
  else delete metadata[FOLLOW_UPS_KEY]
  storage.updateBinding(bindingId, { metadata: Object.keys(metadata).length > 0 ? metadata : null })
}

// ---- Nudges ----

/** "from Alice, agent-b and 2 others" — who the unread messages are from (system notices skipped). */
export function describeSenders(messages: ChannelMessage[]): string {
  const names = [...new Set(messages.filter((m) => m.senderType !== 'system').map((m) => m.senderName))]
  if (names.length === 0) return ''
  if (names.length <= 3) return ` from ${names.join(', ')}`
  return ` from ${names.slice(0, 2).join(', ')} and ${names.length - 2} others`
}

/** `where` is the stream's target: '#general' or '#general:0000002a'. */
export function buildPeerNudge(count: number, where: string, senders: string): string {
  return (
    `[System notification: ${count} new message(s) in ${where}${senders}. ` +
    `Call check_messages before you reply there — they may already cover what you were going to say.]`
  )
}

type PeerStorage = Pick<AgentBindingStorageAdapter, 'listBindingsForScope' | 'getBinding' | 'upsertCursor'>
  & Pick<ChannelStorageAdapter, 'getThread' | 'getChannelMessage' | 'getUnreadChannelMessages' | 'getUnreadThreadMessages'>

const debounceKey = (bindingId: number) => `peer:${bindingId}`

/** Drop a binding's pending peer nudge (its turn ended; re-wake planning covers it). */
export function cancelPeerNudge(bindingId: number): void {
  cancelDebounce(debounceKey(bindingId))
}

/**
 * An agent posted: nudge every other session reading where it posted — the
 * channel sessions for a main-channel message, the thread's sessions for a
 * thread reply — that is currently running. Fire-and-forget.
 */
export function nudgeActivePeers(
  storage: PeerStorage,
  channel: { id: number; name: string },
  message: ChannelMessage,
): void {
  if (message.senderType !== 'agent') return
  const sessions = message.threadRootId != null
    ? storage.listBindingsForScope('thread', String(message.threadRootId))
    : storage.listBindingsForScope('app', String(channel.id))
  for (const binding of sessions) {
    if (isSender(binding, message)) continue
    if (binding.status !== 'active' || binding.activeChatId == null) continue
    const bindingId = binding.id
    const chatId = binding.activeChatId
    debounceNotify(debounceKey(bindingId), PEER_NUDGE_DEBOUNCE_MS, () => {
      flushPeerNudge(storage, bindingId, chatId, channel).catch((err) => {
        console.error(`[PeerAwareness] nudge failed binding=${bindingId}:`, err)
      })
    })
  }
}

async function flushPeerNudge(
  storage: PeerStorage,
  bindingId: number,
  chatId: number,
  channel: { id: number; name: string },
): Promise<void> {
  // The turn may have ended (or a new one started) during the quiet period.
  const binding = storage.getBinding(bindingId)
  if (!binding || binding.status !== 'active' || binding.activeChatId !== chatId) return

  const stream = streamOfBinding(storage, binding)
  if (!stream) return
  // Already read (check_messages / a held send) during the quiet period.
  const unread = unreadIn(storage, binding.agentId, stream)
  if (unread.length === 0) return

  // Steer only, and no wake on failure: a follow-up would queue a whole extra
  // turn, bypassing the follow-up limit. Turn-end planning covers the rest.
  const where = streamTarget(channel.name, stream)
  const receipt = await injectIntoChat(chatId, buildPeerNudge(unread.length, where, describeSenders(unread)), undefined, {
    mode: 'steer',
  })
  if (receipt.delivery === 'not-sent') {
    console.log(`[PeerAwareness] nudge not delivered binding=${bindingId}: ${receipt.error ?? 'unknown'}`)
  }
}

/** Whether `binding` is the session that posted `message` (older rows carry no binding: the agent then). */
export function isSender(binding: Pick<AgentBinding, 'id' | 'agentId'>, message: ChannelMessage): boolean {
  if (message.senderBindingId != null) return message.senderBindingId === binding.id
  return message.senderType === 'agent' && message.senderId === binding.agentId
}
