import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  IMStorageAdapter,
} from '../../storage/interface.js'
import type { IMMessageRow, IMSource } from '../../types/im.js'
import type { AgentBinding } from '../../types/agent-binding.js'
import { parseCommand } from './interactive/parse-command.js'
import { classifySender, type IMEvent, type IMProvider } from './types.js'
import type { IMProviderRegistry } from './registry.js'
import type { MateCommandContext } from './slash-commands/types.js'
import type { SlashCommandRegistry } from './slash-commands/registry.js'

type InboundStorage = IMStorageAdapter
  & AgentBindingStorageAdapter
  & Pick<ChannelStorageAdapter, 'getAgent'>

export interface MateWakeInput {
  agentId: number
  source: string
  sourceChannel: string
  bindingId: number
  workspaceId: number
  trigger: IMMessageRow
}

export interface InboundHooks {
  /** Called when a mate agent should wake for a channel; fire-and-forget. */
  wakeMate: (input: MateWakeInput) => void | Promise<void>
  /**
   * Called when a mate channel has no workspace configured yet. Consumer runs
   * the setup-wizard against the provider and calls
   * `storage.updateIMBindingWorkspace` on completion.
   */
  startMateSetup: (input: MateSetupInput) => void | Promise<void>
}

export interface MateSetupInput {
  provider: IMProvider
  bindingId: number
  agentId: number
  sourceChannel: string
  threadRef: string | undefined
}

export class InboundPipeline {
  constructor(
    private storage: InboundStorage,
    private registry: IMProviderRegistry,
    private hooks: InboundHooks,
    private slashRegistry: SlashCommandRegistry,
  ) {}

  attach(provider: IMProvider): () => void {
    return provider.onEvent((ev) => {
      this.handle(provider, ev).catch((err) => {
        console.error(`[IM:inbound] ${provider.source}:${provider.instanceId} handler error:`, err)
      })
    })
  }

  async handle(provider: IMProvider, ev: IMEvent): Promise<void> {
    if (ev.kind !== 'message') return

    const mateAgentId = provider.agentId
    if (mateAgentId == null) {
      console.warn(`[IM:inbound] mate provider ${provider.source}:${provider.instanceId} missing agentId; dropping`)
      return
    }

    const senderClass = classifySender(
      provider.source,
      ev.senderId,
      ev.senderIsBot,
      this.registry.getSelfIndex(),
    )

    // im_messages is this agent's inbox — its own outbound echo is not inbox
    // content. Drop before writing so handleMateFinish's unread scan stays
    // accurate and we don't take up storage with self-echo rows.
    if (senderClass.kind === 'self_bot' && senderClass.agentId === mateAgentId) {
      console.log(
        `[IM:inbound] early-drop self-echo agent=${mateAgentId} ${provider.source}:${ev.sourceChannel} ts=${ev.sourceTs} sender=${ev.senderId} text=${JSON.stringify(ev.text.slice(0, 120))}`,
      )
      return
    }

    const scopeKind = provider.source as 'slack' | 'telegram'
    const preBindings = this.storage.listBindingsForScope(scopeKind, ev.sourceChannel)
    const nameMap = this.buildAgentNameMap(preBindings, provider)
    const normalizedText = normalizeAgentMentions(ev.text, nameMap)

    let senderName = ev.senderName
    if (senderClass.kind === 'self_bot' && senderClass.agentId != null) {
      const agent = this.storage.getAgent(senderClass.agentId)
      if (agent?.name) senderName = agent.name
    }

    const { row } = this.storage.insertIMMessage({
      recipientAgentId: mateAgentId,
      source: provider.source,
      sourceChannel: ev.sourceChannel,
      sourceTs: ev.sourceTs,
      senderKind: senderClass.kind,
      senderId: ev.senderId,
      senderName,
      senderAgentId: senderClass.kind === 'self_bot' ? senderClass.agentId ?? null : null,
      text: normalizedText,
      threadRef: ev.threadRef ?? null,
      replyToRef: ev.replyToRef ?? null,
      attachmentsJson: ev.attachments?.length ? JSON.stringify(ev.attachments) : null,
      rawJson: ev.raw != null ? safeJson(ev.raw) : null,
    })

    // Each bot has its own socket — this handler only decides whether THIS
    // provider's agent should wake for this message. Per-bot fan-out happens
    // naturally because Slack delivers the same event to each bot's socket.
    const binding = this.ensureBinding(provider, ev, mateAgentId)

    // A fresh binding (or a binding that was never configured) has no
    // workspace. Only a human message kicks off the setup-wizard — bot
    // chatter (including another agent's own wizard posts in the same
    // channel) must not trigger setup, otherwise two agents joining at
    // once ping-pong each other's wizard messages into a storm. wakeMate
    // is suppressed until the wizard writes a workspace_id.
    if (binding.workspaceId == null) {
      if (senderClass.kind !== 'human') {
        console.log(
          `[IM:inbound] mate-setup-skip agent=${mateAgentId} ${provider.source}:${ev.sourceChannel} ` +
          `binding=${binding.id} row=${row.id} senderKind=${senderClass.kind} — non-human, not triggering setup`,
        )
        return
      }
      console.log(
        `[IM:inbound] mate-setup agent=${mateAgentId} ${provider.source}:${ev.sourceChannel} ` +
        `binding=${binding.id} row=${row.id} — no workspace, running setup-wizard`,
      )
      await this.hooks.startMateSetup({
        provider,
        bindingId: binding.id,
        agentId: mateAgentId,
        sourceChannel: ev.sourceChannel,
        threadRef: ev.threadRef,
      })
      return
    }

    if (senderClass.kind === 'human') {
      const commandText = stripLeadingMentions(row.text).trim()
      const parsed = parseCommand(commandText)
      if (parsed.isCommand && parsed.commandName) {
        const cmd = this.slashRegistry.get(parsed.commandName, 'mate')
        if (cmd) {
          const bindings = this.storage.listBindingsForScope(scopeKind, ev.sourceChannel)
          const targets = this.resolveCommandTargets(mateAgentId, provider.source, ev, row, bindings)
          const targeted = targets.includes(mateAgentId)
          console.log(
            `[IM:inbound] command=${parsed.commandName} agent=${mateAgentId} ` +
            `${provider.source}:${ev.sourceChannel} row=${row.id} targeted=${targeted} ` +
            `targets=[${targets.join(',')}]`,
          )
          if (!targeted) return

          const agent = this.storage.getAgent(mateAgentId)
          if (!agent) return

          await this.slashRegistry.dispatch('mate', commandText, (commandName, args) => {
            const ctx: MateCommandContext = {
              mode: 'mate',
              provider,
              ref: { sourceChannel: ev.sourceChannel, threadRef: ev.threadRef },
              source: provider.source,
              sourceChannel: ev.sourceChannel,
              agentId: mateAgentId,
              agent,
              bindingId: binding.id,
              workspaceId: binding.workspaceId as number,
              triggerMessage: row,
              commandName,
              args,
            }
            return ctx
          })
          return
        }
        // Unknown command — fall through to wakeMate so the LLM can handle it.
      }
    }

    console.log(
      `[IM:inbound] wake agent=${mateAgentId} ${provider.source}:${ev.sourceChannel} ` +
      `binding=${binding.id} workspace=${binding.workspaceId} ` +
      `row=${row.id} ts=${ev.sourceTs} senderKind=${senderClass.kind} ` +
      `senderId=${ev.senderId} senderAgentId=${row.senderAgentId ?? 'null'} ` +
      `text=${JSON.stringify(row.text.slice(0, 120))}`,
    )
    await this.hooks.wakeMate({
      agentId: mateAgentId,
      source: provider.source,
      sourceChannel: ev.sourceChannel,
      bindingId: binding.id,
      workspaceId: binding.workspaceId,
      trigger: row,
    })
  }

  /**
   * Command routing (/stop, /reset): DM is unambiguous; group chat requires an
   * explicit target via @mention or reply-to-agent-message. A bare command in
   * a group is a no-op.
   */
  private resolveCommandTargets(
    mateAgentId: number,
    source: IMSource,
    ev: IMEvent,
    row: IMMessageRow,
    bindings: AgentBinding[],
  ): number[] {
    const bindingAgents = new Set(bindings.map((b) => b.agentId))
    if (bindingAgents.size === 0) return []

    const dmBinding = bindings.find((b) => b.channelKind === 'dm')
    if (dmBinding && ev.isDM) return [dmBinding.agentId]

    const targets = new Set<number>()

    if (ev.mentionedUserIds?.length) {
      const selfIndex = this.registry.getSelfIndex()
      for (const uid of ev.mentionedUserIds) {
        const hit = selfIndex.get(`${source}:${uid}`)
        if (hit?.agentId != null && bindingAgents.has(hit.agentId)) {
          targets.add(hit.agentId)
        }
      }
    }

    if (targets.size === 0 && row.replyToRef) {
      const replied = this.storage.getIMMessageByNativeTs(mateAgentId, source, ev.sourceChannel, row.replyToRef)
      if (
        replied?.senderKind === 'self_bot' &&
        replied.senderAgentId != null &&
        bindingAgents.has(replied.senderAgentId)
      ) {
        targets.add(replied.senderAgentId)
      }
    }

    return [...targets]
  }

  /**
   * Build a map of Slack/Telegram user/bot id → agent name, covering:
   *   - The current provider (even if its self-heal binding hasn't landed yet).
   *   - Any other agent bound to the same channel (each has its own provider
   *     with its own selfUserId / selfBotId).
   *
   * Inbound text contains raw IM ids (e.g. `@U0AU3QDMH6X`); rewriting them to
   * `@<agent-name>` lets the LLM recognize when it is being addressed and
   * distinguish mentions of other agents from mentions of itself.
   */
  private buildAgentNameMap(
    bindings: AgentBinding[],
    currentProvider: IMProvider,
  ): Map<string, string> {
    const map = new Map<string, string>()
    const add = (prov: IMProvider | undefined, agentId: number | null): void => {
      if (!prov || agentId == null) return
      const agent = this.storage.getAgent(agentId)
      if (!agent) return
      if (prov.selfUserId) map.set(prov.selfUserId, agent.name)
      if (prov.selfBotId) map.set(prov.selfBotId, agent.name)
      // Telegram inbound text carries `@username` (not numeric id), so we also
      // index by username so normalizeAgentMentions can rewrite it.
      if (prov.selfUsername) map.set(prov.selfUsername, agent.name)
    }
    add(currentProvider, currentProvider.agentId)
    for (const binding of bindings) {
      if (binding.imProviderInstanceId == null) continue
      add(this.registry.getProvider(binding.imProviderInstanceId), binding.agentId)
    }
    return map
  }

  /**
   * Return the binding for (channel, agent), creating it on first contact.
   * New bindings start with workspace_id = NULL, which tells the caller to
   * run the mate setup-wizard instead of waking the agent.
   */
  private ensureBinding(provider: IMProvider, ev: IMEvent, agentId: number): AgentBinding {
    const scopeKind = provider.source as 'slack' | 'telegram'
    const existing = this.storage.getBindingByScope(scopeKind, ev.sourceChannel, agentId)
    if (existing) return existing
    return this.storage.upsertBinding({
      agentId,
      scopeKind,
      scopeKey: ev.sourceChannel,
      scopeDisplayName: ev.sourceChannelName ?? null,
      channelKind: ev.isDM ? 'dm' : 'channel',
      imProviderInstanceId: provider.providerId,
      status: 'offline',
    })
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return 'null'
  }
}

/**
 * Strip leading `@<word>` mentions (plus whitespace) so command-prefix checks
 * like `@Codex /reset` match `/reset`. Also handles Slack-raw `<@U...>` in case
 * normalization ran on a text that still contained them.
 */
function stripLeadingMentions(text: string): string {
  return text.replace(/^(?:\s*(?:<@[^>]+>|@\S+))+\s*/, '')
}

/**
 * Rewrite `@<id>` tokens in inbound text to `@<agent-name>` when the id
 * resolves to one of our bound agents. Unknown ids pass through unchanged,
 * so human-only mentions keep their original form.
 */
function normalizeAgentMentions(text: string, nameMap: Map<string, string>): string {
  if (nameMap.size === 0 || !text) return text
  return text.replace(/@([A-Za-z0-9._-]+)/g, (match, id: string) => {
    const name = nameMap.get(id)
    return name ? `@${name}` : match
  })
}
