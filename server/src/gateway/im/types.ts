import type { IMProviderMode, IMSource } from '../../types/im.js'

export type IMCapability =
  | 'threads'
  | 'dm'
  | 'attachments'
  | 'edit_message'
  | 'buttons'
  | 'url_buttons'
  | 'web_app'
  | 'reactions'
  | 'bot_to_bot_visible'

export type SlackFileRef = { kind: 'slack-file'; fileId: string; urlPrivate: string }
export type TelegramFileRef = { kind: 'tg-file'; fileId: string }
export type AttachmentProviderRef = SlackFileRef | TelegramFileRef

export interface IMAttachment {
  type: 'image' | 'file' | 'audio' | 'video' | 'other'
  url: string
  mime?: string
  name?: string
  size?: number
  providerRef?: AttachmentProviderRef
}

export interface ChannelRef {
  sourceChannel: string
  threadRef?: string
}

export interface SendOptions {
  replyToRef?: string
}

export type IMEventKind = 'message' | 'reaction' | 'edit' | 'delete'

export interface IMEvent {
  kind: IMEventKind
  sourceChannel: string
  sourceChannelName?: string
  isDM?: boolean
  sourceTs: string
  senderId: string
  senderName: string
  senderIsBot?: boolean
  text: string
  threadRef?: string
  replyToRef?: string
  attachments?: IMAttachment[]
  mentionedUserIds?: string[]
  raw: unknown
}

export interface Choice {
  id: string
  label: string
  description?: string
}

export interface AskChoiceOptions {
  timeoutMs?: number
}

export interface StreamWriter {
  update(text: string): Promise<void>
  finish(text: string): Promise<string | undefined>
  abort(): void
}

export interface PendingDiff {
  filePath: string
  oldContent: string
  newContent: string
}

export interface DiffPreview {
  viewUrl: string
  fileName: string
}

export interface DiffWorkerConfig {
  workerUrl: string
  workerApiKey: string
}

/**
 * Unified IMProvider — the single abstraction implemented once per source.
 * The same provider instance serves both modes; consumers (InboundPipeline
 * for mate, InteractiveDispatcher for interactive) attach via onEvent().
 *
 * Mode-agnostic API surface:
 *   - start/stop lifecycle
 *   - onEvent: inbound firehose
 *   - send / sendPlain: one-shot outbound
 *   - createStreamWriter: progressive edit-or-append streaming
 *   - sendToolNotification / updateToolNotification: small status lines
 *   - askChoice / cancelPendingChoice: button-or-text-fallback choice UI
 *   - sendDiffPreview: URL-backed diff view
 *   - resolveTarget / formatTarget: string ↔ ChannelRef
 *
 * Methods take ChannelRef rather than an opaque chatId string. Consumers that
 * need a stable map key should use `formatTarget(ref)` (already includes the
 * source prefix) — add the providerId if routing across multiple providers.
 */
export interface IMProvider {
  readonly source: IMSource
  readonly instanceId: string
  readonly providerId: number
  readonly mode: IMProviderMode
  readonly agentId: number | null
  readonly selfUserId: string
  readonly selfBotId: string | null
  /**
   * Platform username (Telegram `@bot_name` without the `@`, lowercased).
   * Used by the registry to resolve `@username` mentions back to providers —
   * Telegram inbound text carries usernames, not numeric ids. Slack mentions
   * are always raw `<@U...>` so this stays null there.
   */
  readonly selfUsername: string | null
  readonly displayName: string
  readonly capabilities: ReadonlySet<IMCapability>

  start(): Promise<void>
  stop(): Promise<void>

  onEvent(handler: (ev: IMEvent) => void): () => void

  send(ref: ChannelRef, content: string, opts?: SendOptions): Promise<{ sourceTs: string }>
  sendPlain(ref: ChannelRef, text: string, opts?: SendOptions): Promise<{ sourceTs: string }>

  createStreamWriter(ref: ChannelRef): StreamWriter

  sendToolNotification(ref: ChannelRef, text: string): Promise<string | undefined>
  updateToolNotification(ref: ChannelRef, messageId: string, text: string): Promise<void>

  askChoice(
    ref: ChannelRef,
    question: string,
    choices: Choice[],
    options?: AskChoiceOptions,
  ): Promise<string>

  cancelPendingChoice(ref: ChannelRef, reason: string): void

  sendDiffPreview(ref: ChannelRef, preview: DiffPreview): Promise<void>

  /**
   * Post a platform-native reaction on a specific message. Best-effort — errors
   * must not propagate. Only wired when `capabilities` includes 'reactions'.
   * `emoji` is the platform's short name (e.g. Slack's `eyes`, no colons).
   */
  addReaction?(ref: ChannelRef, sourceTs: string, emoji: string): Promise<void>

  fetchHistory?(
    ref: ChannelRef,
    since: { sourceTs?: string; limit?: number },
  ): Promise<IMEvent[]>

  /**
   * Fetch the raw bytes of an inbound attachment. Optional — providers without
   * this method can't deliver images inline (`attachment-loader` will mark them
   * `dropped`). Implementations own the platform-specific download path
   * (Slack: bearer-auth fetch of `url_private`; Telegram: `getFile` then fetch).
   */
  fetchAttachmentBytes?(
    attachment: IMAttachment,
  ): Promise<{ data: Buffer; mimeType: string }>

  resolveTarget(target: string): ChannelRef
  formatTarget(ref: ChannelRef): string

  systemPromptFragment?(): string
}

export type IMSenderClass =
  | { kind: 'self_bot'; agentId: number | null }
  | { kind: 'external_bot' }
  | { kind: 'human' }

export function classifySender(
  source: IMSource,
  senderId: string,
  isBot: boolean | undefined,
  selfIndex: Map<string, { providerId: number; agentId: number | null }>,
): IMSenderClass {
  const hit = selfIndex.get(`${source}:${senderId}`)
  if (hit) return { kind: 'self_bot', agentId: hit.agentId }
  if (isBot) return { kind: 'external_bot' }
  return { kind: 'human' }
}
