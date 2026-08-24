// In-app channel slash-command interception — parity with the IM gateway
// (gateway/im/inbound-pipeline). A human message like `@Codex /reset` is handled
// here (tear down the targeted agent's binding for this channel) instead of being
// forwarded to the model, which would otherwise just role-play the command.
//
// Only `/reset` is intercepted; every other `/...` flows through unchanged so we
// never block a command the agent itself might understand.

import type { AgentBindingStorageAdapter, ChannelStorageAdapter } from '../../storage/interface.js'
import type { ChannelMessage } from '../../types/channel.js'
import { parseCommand } from '../../gateway/im/interactive/parse-command.js'
import { resetBinding } from './binding-reset.js'

/** Storage capabilities this module needs: channel reads/writes + binding lookup/reset. */
type ChannelCommandStorage = ChannelStorageAdapter & AgentBindingStorageAdapter

/** Strip leading `@name` mentions off the text; return the mentioned names + the remainder. */
function splitLeadingMentions(text: string): { mentions: string[]; rest: string } {
  const mentions: string[] = []
  let rest = text.trimStart()
  const re = /^@(\S+)\s*/
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    mentions.push(m[1])
    rest = rest.slice(m[0].length)
  }
  return { mentions, rest }
}

function postSystem(
  storage: ChannelCommandStorage,
  channelId: number,
  content: string,
  emit: (m: ChannelMessage) => void,
): void {
  const msg = storage.createMessage({ channelId, senderType: 'system', senderName: 'system', content })
  emit(msg)
}

/**
 * Handle a human `/reset` (optionally `@agent /reset`) posted to an in-app
 * channel. Resolves the leading `@mentions` to the channel's member agents and
 * resets each one's binding for THIS channel, so its next message cold-starts.
 *
 * Returns `true` when the message was a `/reset` and has been handled — the
 * caller must then NOT route it to agents. Returns `false` for anything that is
 * not our command, so normal routing proceeds unchanged.
 */
export async function handleChannelSlashCommand(
  storage: ChannelCommandStorage,
  channelId: number,
  message: ChannelMessage,
  emit: (m: ChannelMessage) => void,
): Promise<boolean> {
  if (message.senderType !== 'human') return false
  const { mentions, rest } = splitLeadingMentions(message.content)
  const parsed = parseCommand(rest)
  if (!parsed.isCommand || parsed.commandName !== 'reset') return false

  // Resolve the @mentions to this channel's member agents (case-insensitive).
  const memberAgents = storage
    .listMembers(channelId)
    .map((m) => storage.getAgent(m.agentId))
    .filter((a): a is NonNullable<typeof a> => a != null)
  const wanted = new Set(mentions.map((n) => n.toLowerCase()))
  const targets = memberAgents.filter((a) => wanted.has(a.name.toLowerCase()))

  if (targets.length === 0) {
    // A channel is multi-agent, so `/reset` must name a target — mirror the IM
    // gateway's "group chat requires a mention" rule rather than guess.
    postSystem(storage, channelId, 'Mention an agent to reset, e.g. `@Codex /reset`.', emit)
    return true
  }

  const reset: string[] = []
  for (const agent of targets) {
    const binding = storage.getBindingByScope('app', String(channelId), agent.id)
    if (binding) {
      await resetBinding(storage, binding)
      reset.push(agent.name)
    }
  }
  postSystem(
    storage,
    channelId,
    reset.length > 0
      ? `🔄 Reset ${reset.join(', ')} in this channel — the next message starts a fresh session.`
      : `Nothing to reset for ${targets.map((a) => a.name).join(', ')} (no active session).`,
    emit,
  )
  return true
}
