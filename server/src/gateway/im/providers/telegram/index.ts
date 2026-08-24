import { Bot } from 'gramio'
import type { IMProviderRecord, IMSourceMeta } from '../../../../types/im.js'
import type { ProviderFactory } from '../../registry.js'
import type {
  ChannelRef,
  DiffPreview,
  IMAttachment,
  IMProvider,
  SendOptions,
  StreamWriter,
} from '../../types.js'
import { BaseIMProvider } from '../../base-provider.js'
import type { ChoiceRenderer, PageView } from '../../choice-paginator.js'
import {
  extractTelegramMentions,
  type TelegramMessageEntity,
} from '../../mention-extractor.js'
import {
  sendDraftUpdate,
  sendFormattedMessage,
  sendPlainMessage,
  sendToolNotification,
} from './message-sender.js'

const SOURCE = 'telegram' as const
const MAX_LABEL_LEN = 40

interface TelegramCredentials {
  botToken: string
}

interface TelegramConfig {
  allowedUserIds?: number[]
}

interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  width?: number
  height?: number
  file_size?: number
}

interface TelegramMessageContext {
  chat: { id: number; type: string }
  from?: {
    id: number
    is_bot?: boolean
    username?: string
    first_name?: string
    last_name?: string
  }
  text?: string
  caption?: string
  photo?: TelegramPhotoSize[]
  id: number
  threadId?: number | null
  replyMessage?: { id: number }
  entities?: TelegramMessageEntity[]
  captionEntities?: TelegramMessageEntity[]
}

export class TelegramProvider extends BaseIMProvider {
  readonly source = SOURCE

  private readonly bot: Bot
  private readonly config: TelegramConfig
  private readonly botToken: string

  constructor(record: IMProviderRecord) {
    super(record, ['dm', 'attachments', 'edit_message', 'buttons', 'web_app'])
    const creds = parseCredentials(record.credentialsJson)
    this.config = parseConfig(record.configJson)
    this.botToken = creds.botToken
    this.bot = new Bot(creds.botToken)
    this.installHandlers()
  }

  async start(): Promise<void> {
    try {
      const me = await this.bot.api.getMe()
      if (me?.id != null) this.selfUserId = String(me.id)
      const uname = (me as { username?: string } | null)?.username
      if (uname) this.selfUsername = uname.toLowerCase()
    } catch (err) {
      console.warn(`[Telegram:${this.instanceId}] getMe failed:`, errMsg(err))
    }
    await this.bot.start()
    console.log(`[Telegram:${this.instanceId}] started (polling)`)
  }

  async stop(): Promise<void> {
    this.paginator.dispose()
    try { this.bot.stop() } catch { /* ignore */ }
    console.log(`[Telegram:${this.instanceId}] stopped`)
  }

  async send(ref: ChannelRef, content: string, opts?: SendOptions): Promise<{ sourceTs: string }> {
    const chatId = parseInt(ref.sourceChannel, 10)
    const threadId = ref.threadRef ? parseInt(ref.threadRef, 10) : undefined
    const replyToMessageId = opts?.replyToRef ? parseInt(opts.replyToRef, 10) : undefined
    const messageId = await sendFormattedMessage(this.bot, chatId, content, {
      messageThreadId: threadId,
      replyToMessageId,
    })
    return { sourceTs: messageId != null ? String(messageId) : '' }
  }

  async sendPlain(ref: ChannelRef, text: string, opts?: SendOptions): Promise<{ sourceTs: string }> {
    const chatId = parseInt(ref.sourceChannel, 10)
    const threadId = ref.threadRef ? parseInt(ref.threadRef, 10) : undefined
    const replyToMessageId = opts?.replyToRef ? parseInt(opts.replyToRef, 10) : undefined
    const messageId = await sendPlainMessage(this.bot, chatId, text, {
      messageThreadId: threadId,
      replyToMessageId,
    })
    return { sourceTs: String(messageId) }
  }

  createStreamWriter(ref: ChannelRef): StreamWriter {
    const chatId = parseInt(ref.sourceChannel, 10)
    const threadId = ref.threadRef ? parseInt(ref.threadRef, 10) : undefined
    const opts = threadId ? { messageThreadId: threadId } : {}
    let aborted = false

    return {
      update: async (text: string) => {
        if (aborted) return
        await sendDraftUpdate(this.bot, chatId, text, opts)
      },
      finish: async (text: string) => {
        if (aborted) return undefined
        const id = await sendFormattedMessage(this.bot, chatId, text, opts)
        return id != null ? String(id) : undefined
      },
      abort: () => { aborted = true },
    }
  }

  async sendToolNotification(ref: ChannelRef, text: string): Promise<string | undefined> {
    const chatId = parseInt(ref.sourceChannel, 10)
    const threadId = ref.threadRef ? parseInt(ref.threadRef, 10) : undefined
    const messageId = await sendToolNotification(this.bot, chatId, text, {
      messageThreadId: threadId,
    })
    return String(messageId)
  }

  async updateToolNotification(ref: ChannelRef, messageId: string, text: string): Promise<void> {
    const chatId = parseInt(ref.sourceChannel, 10)
    try {
      await this.bot.api.editMessageText({
        chat_id: chatId,
        message_id: parseInt(messageId, 10),
        text,
      })
    } catch {
      // "message is not modified" is expected
    }
  }

  async fetchAttachmentBytes(
    attachment: IMAttachment,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const ref = attachment.providerRef
    if (!ref || ref.kind !== 'tg-file') {
      throw new Error('Telegram fetchAttachmentBytes: missing tg-file providerRef')
    }
    // chatcode equivalent: ctx.telegram.getFileLink(file_id) + fetch.
    // gramio doesn't bundle that helper, so we do the two steps explicitly.
    const file = await this.bot.api.getFile({ file_id: ref.fileId })
    const filePath = (file as { file_path?: string } | null)?.file_path
    if (!filePath) {
      throw new Error('Telegram getFile returned no file_path')
    }
    const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Telegram file fetch failed: ${res.status}`)
    }
    const data = Buffer.from(await res.arrayBuffer())
    return { data, mimeType: attachment.mime ?? mimeFromExt(filePath) }
  }

  async sendDiffPreview(ref: ChannelRef, preview: DiffPreview): Promise<void> {
    const chatId = parseInt(ref.sourceChannel, 10)
    const threadId = ref.threadRef ? parseInt(ref.threadRef, 10) : undefined
    await this.bot.api.sendMessage({
      chat_id: chatId,
      text: `📄 ${preview.fileName}`,
      ...(threadId ? { message_thread_id: threadId } : {}),
      reply_markup: {
        inline_keyboard: [[{
          text: '📄 View Diff',
          web_app: { url: preview.viewUrl },
        }]],
      },
    })
  }

  resolveTarget(target: string): ChannelRef {
    const parts = target.split(':')
    if (parts[0] !== SOURCE || parts.length < 2) {
      throw new Error(`Invalid telegram target: ${target}`)
    }
    const sourceChannel = parts[1]
    const threadRef = parts[2] && parts[2] !== '0' ? parts[2] : undefined
    return { sourceChannel, threadRef }
  }

  formatTarget(ref: ChannelRef): string {
    return ref.threadRef
      ? `${SOURCE}:${ref.sourceChannel}:${ref.threadRef}`
      : `${SOURCE}:${ref.sourceChannel}`
  }

  systemPromptFragment(): string {
    return [
      'Platform: Telegram.',
      'Target URI: `telegram:<chat-id>[:<topic-id>]`.',
      'Telegram threads work differently from Slack — IGNORE the generic "start a new thread by using msg= as the third segment" guidance above for this platform.',
      'The third segment is a pre-existing forum-topic id, NOT an arbitrary message id. You cannot create a topic by inventing a new id — Telegram will reject it.',
      'Rule: always reuse the incoming `target` verbatim. If the incoming target has a third segment, your reply stays in that forum topic. If it does not, send to `telegram:<chat-id>` with no third segment — never append a `msg=` value as a thread suffix.',
      'Regular (non-forum) groups and DMs have no thread concept on Telegram. Quote-reply (`reply_to_message_id`) is not exposed via send_message; just reply in the chat.',
      'Use plain text (no markdown); line breaks render. Avoid mrkdwn/Block Kit syntax.',
      'Mentions: incoming text has already been rewritten so `@<your-name>` means you are being addressed; other `@<name>` tokens reference a different participant — do not reply unless explicitly addressed.',
    ].join(' ')
  }

  protected renderChoices(ref: ChannelRef): ChoiceRenderer {
    const chatId = parseInt(ref.sourceChannel, 10)
    const threadId = ref.threadRef ? parseInt(ref.threadRef, 10) : null

    const trunc = (label: string) =>
      label.length <= MAX_LABEL_LEN ? label : '…' + label.slice(-(MAX_LABEL_LEN - 1))

    const buildKeyboard = (view: PageView): Array<Array<{ text: string; callback_data: string }>> => {
      const rows: Array<Array<{ text: string; callback_data: string }>> = []
      for (const c of view.choices) {
        const label = c.description ? `${c.label} - ${c.description}` : c.label
        rows.push([{ text: trunc(label), callback_data: c.actionId }])
      }
      if (view.nav) {
        const nav: Array<{ text: string; callback_data: string }> = []
        if (view.nav.prev) nav.push({ text: '◀', callback_data: view.nav.prev.actionId })
        nav.push({
          text: `${view.nav.current}/${view.nav.total}`,
          callback_data: `cp:noop:${view.nav.current - 1}`,
        })
        if (view.nav.next) nav.push({ text: '▶', callback_data: view.nav.next.actionId })
        rows.push(nav)
      }
      return rows
    }

    const formatText = (view: PageView): string =>
      view.nav ? `${view.question}\n\n(page ${view.nav.current}/${view.nav.total})` : view.question

    return {
      send: async (view) => {
        const result = await this.bot.api.sendMessage({
          chat_id: chatId,
          text: formatText(view),
          ...(threadId ? { message_thread_id: threadId } : {}),
          reply_markup: { inline_keyboard: buildKeyboard(view) },
        })
        return String(result.message_id)
      },
      edit: async (messageId, view) => {
        await this.bot.api.editMessageText({
          chat_id: chatId,
          message_id: parseInt(messageId, 10),
          text: formatText(view),
          reply_markup: { inline_keyboard: buildKeyboard(view) },
        }).catch(() => {})
      },
      finalize: async (messageId, label) => {
        await this.bot.api.editMessageText({
          chat_id: chatId,
          message_id: parseInt(messageId, 10),
          text: `✅ ${label}`,
        }).catch(() => {})
      },
    }
  }

  private isUserAuthorized(userId: number): boolean {
    if (!this.config.allowedUserIds?.length) return true
    return this.config.allowedUserIds.includes(userId)
  }

  private installHandlers(): void {
    this.bot.on('message', (context) => {
      const c = context as unknown as TelegramMessageContext
      const rawText = c.text ?? c.caption ?? ''
      const attachments = parsePhotoAttachments(c.photo)
      if (!rawText && attachments.length === 0) return

      const chat = c.chat
      if (!chat?.id) return

      const userId = c.from?.id ?? 0
      if (!this.isUserAuthorized(userId)) {
        const chatId = chat.id
        const threadId = c.threadId ?? null
        void sendPlainMessage(this.bot, chatId, 'Unauthorized.',
          threadId ? { messageThreadId: threadId } : {})
        return
      }

      const senderId = c.from?.id != null ? String(c.from.id) : ''
      if (!senderId) return
      const senderName =
        c.from?.username ||
        [c.from?.first_name, c.from?.last_name].filter(Boolean).join(' ').trim() ||
        senderId

      const isDM = chat.type === 'private'
      const threadRef = c.threadId != null ? String(c.threadId) : undefined
      const replyTo = c.replyMessage?.id != null ? String(c.replyMessage.id) : undefined
      const text = rawText || (attachments.length ? '[image]' : '')

      // Entities live on `entities` for text messages, `captionEntities` for
      // media captions — feed whichever matches the text we settled on above.
      const entities = c.text ? c.entities : c.captionEntities
      const mentions = extractTelegramMentions(rawText, entities)

      this.emit({
        kind: 'message',
        sourceChannel: String(chat.id),
        isDM,
        sourceTs: String(c.id),
        senderId,
        senderName,
        senderIsBot: Boolean(c.from?.is_bot),
        text,
        threadRef,
        replyToRef: replyTo,
        attachments: attachments.length ? attachments : undefined,
        mentionedUserIds: mentions,
        raw: context.update,
      })
    })

    this.bot.on('callback_query', async (context) => {
      const data = context.data
      if (!data) return
      const userId = context.from?.id ?? 0

      if (!this.isUserAuthorized(userId)) {
        await context.answer('Unauthorized').catch(() => {})
        return
      }

      const result = await this.paginator.dispatch(data)
      if (result === 'choice') await context.answer('Done').catch(() => {})
      else if (result === 'page') await context.answer().catch(() => {})
      else await context.answer('Expired').catch(() => {})
    })
  }
}

export const telegramSourceMeta: IMSourceMeta = {
  source: SOURCE,
  label: 'Telegram',
  icon: 'Send',
  credentialFields: [
    { key: 'botToken', label: 'Bot Token', secret: true, required: true, placeholder: '1234:ABC...' },
  ],
}

export const telegramProviderFactory: ProviderFactory = {
  source: SOURCE,
  create(record: IMProviderRecord): IMProvider {
    return new TelegramProvider(record)
  },
}

function parseCredentials(raw: string): TelegramCredentials {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Telegram credentials_json is not valid JSON') }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Telegram credentials_json must be an object')
  }
  const obj = parsed as Record<string, unknown>
  const botToken = obj.botToken ?? obj.bot_token
  if (typeof botToken !== 'string' || !botToken) {
    throw new Error('Telegram credentials require botToken')
  }
  return { botToken }
}

function parseConfig(raw: string | null): TelegramConfig {
  if (!raw) return {}
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const out: TelegramConfig = {}
    if (Array.isArray(obj.allowedUserIds)) {
      out.allowedUserIds = (obj.allowedUserIds as unknown[])
        .map((v) => (typeof v === 'number' ? v : Number.parseInt(String(v), 10)))
        .filter((n) => Number.isFinite(n))
    }
    return out
  } catch {
    return {}
  }
}

function parsePhotoAttachments(photo: TelegramPhotoSize[] | undefined): IMAttachment[] {
  if (!photo?.length) return []
  // Telegram delivers an ascending-resolution ladder; the last entry is the largest.
  const largest = photo[photo.length - 1]
  if (!largest?.file_id) return []
  return [{
    type: 'image',
    url: `tg-file://${largest.file_id}`,
    mime: 'image/jpeg',
    size: largest.file_size,
    providerRef: { kind: 'tg-file', fileId: largest.file_id },
  }]
}

function mimeFromExt(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  const ext = dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : ''
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'png': return 'image/png'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    default: return 'application/octet-stream'
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
