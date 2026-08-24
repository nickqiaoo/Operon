import type { IMProviderMode, IMProviderRecord, IMSource } from '../../types/im.js'
import type {
  AskChoiceOptions,
  ChannelRef,
  Choice,
  DiffPreview,
  IMCapability,
  IMEvent,
  IMProvider,
  SendOptions,
  StreamWriter,
} from './types.js'
import { ChoicePaginator, type ChoiceRenderer } from './choice-paginator.js'

/**
 * BaseIMProvider — template class shared by every source.
 *
 * Subclasses own transport (Slack Bolt / gramio Bot), native formatting
 * (mrkdwn, MarkdownV2, blocks, inline_keyboard), and the raw `send/sendPlain`
 * primitives. The base layer fills in capability-gated UI surfaces with
 * sensible text-only fallbacks so a bare-minimum provider only needs:
 *
 *   - start / stop
 *   - installHandlers → emit(IMEvent)
 *   - send / sendPlain
 *   - resolveTarget / formatTarget
 *
 * Providers override the fallbacks when they have a native rendering. The
 * ChoicePaginator is owned here because its state machine is identical
 * across platforms; subclasses just provide a `renderChoices` implementation.
 */
export abstract class BaseIMProvider implements IMProvider {
  abstract readonly source: IMSource
  readonly capabilities: ReadonlySet<IMCapability>

  readonly instanceId: string
  readonly providerId: number
  readonly mode: IMProviderMode
  readonly agentId: number | null
  readonly displayName: string
  selfUserId: string
  selfBotId: string | null
  selfUsername: string | null = null

  protected readonly paginator: ChoicePaginator
  private readonly handlers: Array<(ev: IMEvent) => void> = []

  constructor(record: IMProviderRecord, capabilities: IMCapability[]) {
    this.instanceId = record.instanceId
    this.providerId = record.id
    this.mode = record.mode
    this.agentId = record.agentId
    this.displayName = record.displayName
    this.selfUserId = record.selfUserId
    this.selfBotId = record.selfBotId
    this.capabilities = new Set<IMCapability>(capabilities)
    this.paginator = new ChoicePaginator()
  }

  abstract start(): Promise<void>
  abstract stop(): Promise<void>

  onEvent(handler: (ev: IMEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      const idx = this.handlers.indexOf(handler)
      if (idx >= 0) this.handlers.splice(idx, 1)
    }
  }

  protected emit(ev: IMEvent): void {
    for (const h of this.handlers) {
      try {
        h(ev)
      } catch (err) {
        console.error(`[${this.source}:${this.instanceId}] event handler error:`, err)
      }
    }
  }

  abstract send(ref: ChannelRef, content: string, opts?: SendOptions): Promise<{ sourceTs: string }>
  abstract sendPlain(ref: ChannelRef, text: string, opts?: SendOptions): Promise<{ sourceTs: string }>

  /**
   * Default: one-shot final send per chunk. Subclasses with native
   * edit_message support should override with a throttled edit-or-send loop.
   */
  createStreamWriter(ref: ChannelRef): StreamWriter {
    let aborted = false
    let lastSent: string | undefined
    return {
      update: async (text: string) => {
        if (aborted || !text.trim()) return
        if (text === lastSent) return
        lastSent = text
      },
      finish: async (text: string) => {
        if (aborted) return undefined
        const { sourceTs } = await this.send(ref, text)
        return sourceTs || undefined
      },
      abort: () => { aborted = true },
    }
  }

  async sendToolNotification(ref: ChannelRef, text: string): Promise<string | undefined> {
    const { sourceTs } = await this.sendPlain(ref, text)
    return sourceTs || undefined
  }

  /** Default: re-send as new message. Override when edit_message is available. */
  async updateToolNotification(ref: ChannelRef, _messageId: string, text: string): Promise<void> {
    await this.sendPlain(ref, text).catch(() => {})
  }

  askChoice(
    ref: ChannelRef,
    question: string,
    choices: Choice[],
    options: AskChoiceOptions = {},
  ): Promise<string> {
    const key = this.channelKey(ref)
    if (this.capabilities.has('buttons')) {
      return this.paginator.start(key, question, choices, this.renderChoices(ref), {
        timeoutMs: options.timeoutMs,
      })
    }
    return this.textFallbackAskChoice(ref, question, choices, options)
  }

  cancelPendingChoice(ref: ChannelRef, reason: string): void {
    this.paginator.cancel(this.channelKey(ref), reason)
  }

  /**
   * Default: plain URL. Override to emit native url button / web_app button.
   */
  async sendDiffPreview(ref: ChannelRef, preview: DiffPreview): Promise<void> {
    await this.sendPlain(ref, `📄 ${preview.fileName}\n${preview.viewUrl}`).catch(() => {})
  }

  abstract resolveTarget(target: string): ChannelRef
  abstract formatTarget(ref: ChannelRef): string

  systemPromptFragment?(): string

  /**
   * Subclasses that declare 'buttons' must override this to render the
   * ChoicePaginator view natively (inline_keyboard / Block Kit actions).
   * The default throws because askChoice() only calls this when the
   * capability is declared.
   */
  protected renderChoices(_ref: ChannelRef): ChoiceRenderer {
    throw new Error(
      `[${this.source}:${this.instanceId}] capability 'buttons' declared without renderChoices() override`,
    )
  }

  /**
   * Last-resort text-only askChoice. Sends the question + numbered options
   * and blocks on a timeout. A full implementation would need inbound
   * parsing of the user's numeric reply — left stubbed here because every
   * shipped source supports native buttons.
   */
  protected async textFallbackAskChoice(
    ref: ChannelRef,
    question: string,
    choices: Choice[],
    _options: AskChoiceOptions,
  ): Promise<string> {
    const lines = choices.map((c, i) => `${i + 1}. ${c.label}`)
    await this.sendPlain(ref, `${question}\n\n${lines.join('\n')}\n\n(text-fallback not implemented)`)
    throw new Error(`[${this.source}] text fallback askChoice not implemented`)
  }

  /**
   * Stable per-channel key used by ChoicePaginator and any consumer state
   * keyed per (provider, channel). Scoped by providerId so two providers of
   * the same source in the same channel don't collide.
   */
  channelKey(ref: ChannelRef): string {
    return `${this.providerId}:${ref.sourceChannel}:${ref.threadRef ?? '0'}`
  }

  /** External id (without providerId prefix) used for im_interactive_chats rows. */
  externalIdFor(ref: ChannelRef): string {
    return `${ref.sourceChannel}:${ref.threadRef ?? '0'}`
  }
}
