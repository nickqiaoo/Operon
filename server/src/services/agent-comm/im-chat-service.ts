/**
 * ImChatService — agent-facing tool surface for mate-mode agents.
 *
 * Same shape as WorkspaceChatService (sendMessage / checkMessages / readHistory) but
 * backed by im_messages + im_channel_bindings + agent_im_cursors.
 *
 * Target URI format: `<source>:<channelId>[:<sourceTs>]`
 *   - sourceTs is the platform-native message id (Slack `ts`, Telegram
 *     `message_id`). When present as the third segment it anchors the target
 *     to a thread rooted at that message.
 */

import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  IMStorageAdapter,
  ProjectStorageAdapter,
} from '../../storage/interface.js'
import type { IMMessageRow, IMSource } from '../../types/im.js'
import type { IMProviderRegistry } from '../../gateway/im/registry.js'
import type { IMAttachment, IMProvider } from '../../gateway/im/types.js'
import { outboundSend } from '../../gateway/im/outbound.js'
import {
  loadInlineImages,
  MAX_INLINE_IMAGE_BYTES,
  type DroppedImage,
} from '../../gateway/im/attachment-loader.js'

export type ImChatStorage = IMStorageAdapter
  & AgentBindingStorageAdapter
  & Pick<ChannelStorageAdapter, 'getAgent' | 'getAgentByName'>
  & Pick<ProjectStorageAdapter, 'listProjects'>

export interface IMSendResult {
  target: string
  sourceTs: string | undefined
}

/**
 * Mixed content part shape returned to the MCP layer. Mirrors the JSON-RPC
 * `tools/call` `content` array entries — the route handler forwards these
 * verbatim. `image` parts let the model see the bytes inline without a tool
 * round-trip.
 */
export type MCPContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface IMReadHistoryResult {
  parts: MCPContentPart[]
  hasMore: boolean
  oldestId: number | null
}

export class ImChatService {
  constructor(
    private storage: ImChatStorage,
    private registry: IMProviderRegistry,
    private agentId: number,
  ) {}

  async sendMessage(target: string, content: string): Promise<IMSendResult> {
    const parsed = parseTarget(target)
    const binding = this.storage.getBindingByScope(
      parsed.source as 'slack' | 'telegram',
      parsed.sourceChannel,
      this.agentId,
    )
    if (!binding) throw new Error(`Agent not bound to ${parsed.source}:${parsed.sourceChannel}`)
    if (binding.imProviderInstanceId == null) {
      throw new Error(`Binding ${binding.id} missing IM provider instance`)
    }

    const provider = this.registry.getProvider(binding.imProviderInstanceId)
    if (!provider) throw new Error(`Provider ${binding.imProviderInstanceId} not running`)

    const ref = { sourceChannel: parsed.sourceChannel, threadRef: parsed.sourceTs }
    const result = await outboundSend({
      provider,
      target: provider.formatTarget(ref),
      content,
    })

    return { target, sourceTs: result?.sourceTs }
  }

  /**
   * Return mixed-content unread across all channels this agent is bound to.
   * Each unread message becomes a text header line; image attachments arrive
   * inline as `image` parts in the same response so the model can see them
   * without a tool round-trip.
   *
   * Cursor semantics: advances per-channel to the last message whose images
   * all loaded successfully. If a message was partially dropped due to budget,
   * the cursor stops just before it so a follow-up `check_messages` can retry.
   */
  async checkMessages(): Promise<MCPContentPart[]> {
    const bindings = this.storage.listBindings({ agentId: this.agentId })
      .filter((b) => b.scopeKind === 'slack' || b.scopeKind === 'telegram')
    const parts: MCPContentPart[] = []
    let budget = MAX_INLINE_IMAGE_BYTES

    for (const binding of bindings) {
      const source = binding.scopeKind as IMSource
      const sourceChannel = binding.scopeKey
      const unread = this.storage.getUnreadIMMessages(this.agentId, source, sourceChannel, 50)
      if (unread.length === 0) continue

      const provider = binding.imProviderInstanceId != null
        ? this.registry.getProvider(binding.imProviderInstanceId)
        : undefined

      let lastFullyLoadedId: number | null = null

      for (const msg of unread) {
        if (msg.senderAgentId === this.agentId) {
          // Self-echo never reaches the agent but still counts as read.
          lastFullyLoadedId = msg.id
          continue
        }

        const attachments = parseAttachmentsJson(msg.attachmentsJson)
        const result = await this.appendMessageParts(parts, msg, source, sourceChannel, attachments, provider, budget)
        budget = result.remainingBudget
        if (result.budgetHit) {
          // Stop before this message so retry can recover the dropped image.
          break
        }
        lastFullyLoadedId = msg.id
      }

      if (lastFullyLoadedId != null) {
        this.storage.upsertCursor(this.agentId, 'mate', `${source}:${sourceChannel}`, lastFullyLoadedId)
      }
    }

    return parts
  }

  async readHistory(
    target: string,
    limit: number,
    opts: { before?: number; after?: number } = {},
  ): Promise<IMReadHistoryResult> {
    const parsed = parseTarget(target)
    const effectiveLimit = Math.min(Math.max(limit, 1), 100)
    const rows = this.storage.listIMMessages(parsed.source, parsed.sourceChannel, {
      recipientAgentId: this.agentId,
      beforeId: opts.before,
      afterId: opts.after,
      limit: effectiveLimit + 1,
    })
    const hasMore = rows.length > effectiveLimit
    const slice = hasMore ? rows.slice(0, effectiveLimit) : rows

    const binding = this.storage.getBindingByScope(
      parsed.source as 'slack' | 'telegram',
      parsed.sourceChannel,
      this.agentId,
    )
    const provider = binding?.imProviderInstanceId != null
      ? this.registry.getProvider(binding.imProviderInstanceId)
      : undefined

    const parts: MCPContentPart[] = []
    let budget = MAX_INLINE_IMAGE_BYTES
    for (const m of slice) {
      const attachments = parseAttachmentsJson(m.attachmentsJson)
      const r = await this.appendMessageParts(parts, m, parsed.source, parsed.sourceChannel, attachments, provider, budget)
      budget = r.remainingBudget
      // readHistory does NOT short-circuit on budget — drops degrade gracefully
      // because the cursor isn't advanced; agent can re-call read_history later.
    }

    return {
      parts,
      hasMore,
      oldestId: slice.length ? slice[0].id : null,
    }
  }

  /**
   * Append text + (possibly) image parts for one message, sharing an inline
   * byte budget across the surrounding batch. Returns the leftover budget and
   * whether budget caused a real over-budget drop (vs. non-image / fetch error).
   */
  private async appendMessageParts(
    out: MCPContentPart[],
    msg: IMMessageRow,
    source: IMSource,
    sourceChannel: string,
    attachments: IMAttachment[],
    provider: IMProvider | undefined,
    budget: number,
  ): Promise<{ remainingBudget: number; budgetHit: boolean }> {
    const headerLine = this.formatMessageLine(msg, source, sourceChannel, attachments)
    out.push({ type: 'text', text: headerLine })

    if (attachments.length === 0 || !provider) {
      return { remainingBudget: budget, budgetHit: false }
    }

    const result = await loadInlineImages(provider, attachments, budget)
    for (const img of result.loaded) {
      out.push({
        type: 'image',
        data: img.data.toString('base64'),
        mimeType: img.mimeType,
      })
    }
    let budgetHit = false
    for (const d of result.dropped) {
      const placeholder = formatDroppedPlaceholder(d)
      if (placeholder) out.push({ type: 'text', text: placeholder })
      if (d.reason === 'over-budget') budgetHit = true
    }

    return { remainingBudget: budget - result.bytesUsed, budgetHit }
  }

  private formatMessageLine(
    msg: IMMessageRow,
    source: IMSource,
    sourceChannel: string,
    attachments: IMAttachment[],
  ): string {
    const target = formatTarget(source, sourceChannel, msg.threadRef ?? undefined)
    const time = new Date(msg.receivedAt).toISOString()
    const type = msg.senderKind === 'human' ? 'user' : 'agent'
    const tail = formatAttachmentsTail(attachments)
    return `[target=${target} msg=${msg.sourceTs} time=${time} sender=${msg.senderName} type=${type}] ${msg.text}${tail}`
  }
}

// ---- Helpers ----

export interface ParsedTarget {
  source: IMSource
  sourceChannel: string
  sourceTs?: string
}

export function parseTarget(target: string): ParsedTarget {
  const firstColon = target.indexOf(':')
  if (firstColon < 0) {
    throw new Error(`Invalid target "${target}" — expected <source>:<channel>[:<sourceTs>]`)
  }
  const source = target.slice(0, firstColon)
  const rest = target.slice(firstColon + 1)
  const secondColon = rest.indexOf(':')
  if (secondColon < 0) {
    return { source, sourceChannel: rest }
  }
  const sourceChannel = rest.slice(0, secondColon)
  const sourceTs = rest.slice(secondColon + 1)
  return {
    source,
    sourceChannel,
    sourceTs: sourceTs.length > 0 ? sourceTs : undefined,
  }
}

export function formatTarget(source: IMSource, sourceChannel: string, sourceTs?: string): string {
  return sourceTs ? `${source}:${sourceChannel}:${sourceTs}` : `${source}:${sourceChannel}`
}

function parseAttachmentsJson(json: string | null): IMAttachment[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is IMAttachment => !!v && typeof v === 'object' && 'type' in v)
  } catch {
    return []
  }
}

function formatAttachmentsTail(attachments: IMAttachment[]): string {
  if (attachments.length === 0) return ''
  const labels = attachments.map((a) => {
    const mime = a.mime ?? a.type
    const name = a.name ? `,name=${a.name}` : ''
    const note = a.type !== 'image' ? '(unsupported)' : ''
    return `${a.type === 'image' ? 'image' : a.name ?? 'file'}(${mime}${name})${note}`
  })
  return ` [attachments: ${labels.join(', ')}]`
}

function formatDroppedPlaceholder(d: DroppedImage): string | null {
  const name = d.attachment.name ?? d.attachment.url
  switch (d.reason) {
    case 'over-budget':
      return `[image dropped: ${name} — too large for this batch; call check_messages later to retry]`
    case 'fetch-failed':
      return `[image fetch failed: ${name} — try again later]`
    case 'non-image':
      // Already surfaced in the attachments tail of the header line.
      return null
    case 'no-fetcher':
      return `[image unavailable: ${name} — provider does not support inline fetch]`
  }
}
