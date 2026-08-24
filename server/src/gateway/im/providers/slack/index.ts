// ws ESM interop shim: @slack/socket-mode (CJS) does `new ws_1.WebSocket(url)`,
// which Rollup emits as `import ws from 'ws'; new ws.WebSocket(url)`. Node's
// ESM loads ws/wrapper.mjs whose default export is the WebSocket class itself;
// only the CJS entry (index.js) attaches `.WebSocket`/`.WebSocketServer` to it.
// Patch the shared module here before SocketModeClient.start() runs.
import WebSocket, { WebSocketServer } from 'ws'
const wsClass = WebSocket as typeof WebSocket & {
  WebSocket?: typeof WebSocket
  WebSocketServer?: typeof WebSocketServer
  Server?: typeof WebSocketServer
}
if (!wsClass.WebSocket) wsClass.WebSocket = WebSocket
if (!wsClass.WebSocketServer) wsClass.WebSocketServer = WebSocketServer
if (!wsClass.Server) wsClass.Server = WebSocketServer

import {
  App,
  type SlackActionMiddlewareArgs,
  type SlackEventMiddlewareArgs,
  type BlockAction,
} from '@slack/bolt'
import type { KnownBlock, WebClient } from '@slack/web-api'
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
import { extractSlackMentions } from '../../mention-extractor.js'
import {
  createStreamingMessage,
  finalizeStreamingMessage,
  postStreamingUpdate,
  sendFormattedMessage,
  sendPlainMessage,
  sendToolNotification,
  updateToolNotification,
} from './message-sender.js'

const SOURCE = 'slack' as const
const MAX_LABEL_LEN = 75

interface SlackCredentials {
  botToken: string
  appToken: string
}

interface SlackConfig {
  allowedUserIds?: string[]
  allowedChannelIds?: string[]
}

interface SlackFileRaw {
  id?: string
  mimetype?: string
  name?: string
  size?: number
  url_private?: string
  url_private_download?: string
}

interface SlackMessageEventRaw {
  type?: string
  subtype?: string
  channel?: string
  channel_type?: 'im' | 'mpim' | 'channel' | 'group'
  user?: string
  bot_id?: string
  bot_profile?: { name?: string }
  username?: string
  text?: string
  ts?: string
  thread_ts?: string
  files?: SlackFileRaw[]
}

interface SlackBlockActionId {
  action_id: string
}

export class SlackProvider extends BaseIMProvider {
  readonly source = SOURCE

  private readonly app: App
  private readonly client: WebClient
  private readonly config: SlackConfig
  private readonly botToken: string

  constructor(record: IMProviderRecord) {
    super(record, [
      'threads',
      'dm',
      'attachments',
      'edit_message',
      'buttons',
      'url_buttons',
      'reactions',
      'bot_to_bot_visible',
    ])
    const creds = parseCredentials(record.credentialsJson)
    this.config = parseConfig(record.configJson)
    this.botToken = creds.botToken
    this.app = new App({
      token: creds.botToken,
      appToken: creds.appToken,
      socketMode: true,
    })
    this.client = this.app.client
    this.installHandlers()
  }

  async start(): Promise<void> {
    try {
      const auth = await this.client.auth.test()
      if (auth.user_id) this.selfUserId = auth.user_id
      const botId = (auth as { bot_id?: string }).bot_id
      if (botId) this.selfBotId = botId
      console.log(
        `[Slack:${this.instanceId}] auth ok user=${this.selfUserId} team=${auth.team_id ?? ''}`,
      )
    } catch (err) {
      console.warn(`[Slack:${this.instanceId}] auth.test failed:`, errMsg(err))
    }
    await this.app.start()
    console.log(`[Slack:${this.instanceId}] started`)
  }

  async stop(): Promise<void> {
    this.paginator.dispose()
    await this.app.stop().catch(() => {})
    console.log(`[Slack:${this.instanceId}] stopped`)
  }

  async send(ref: ChannelRef, content: string, opts?: SendOptions): Promise<{ sourceTs: string }> {
    const ts = await sendFormattedMessage(this.client, ref.sourceChannel, content, {
      threadTs: opts?.replyToRef ?? ref.threadRef,
    })
    return { sourceTs: ts ?? '' }
  }

  async sendPlain(ref: ChannelRef, text: string, opts?: SendOptions): Promise<{ sourceTs: string }> {
    const ts = await sendPlainMessage(this.client, ref.sourceChannel, text, {
      threadTs: opts?.replyToRef ?? ref.threadRef,
    })
    return { sourceTs: ts }
  }

  createStreamWriter(ref: ChannelRef): StreamWriter {
    const channel = ref.sourceChannel
    const threadTs = ref.threadRef
    let aborted = false
    let messageTs: string | undefined

    return {
      update: async (text: string) => {
        if (aborted || !text.trim()) return
        try {
          if (!messageTs) {
            messageTs = await createStreamingMessage(this.client, channel, text, { threadTs })
          } else {
            await postStreamingUpdate(this.client, channel, messageTs, text)
          }
        } catch (err) {
          console.warn(`[Slack:${this.instanceId}] stream update failed:`, errMsg(err))
        }
      },
      finish: async (text: string) => {
        if (aborted) return undefined
        const ts = messageTs
        messageTs = undefined
        try {
          if (ts) {
            await finalizeStreamingMessage(this.client, channel, ts, text)
            return ts
          }
          return await sendFormattedMessage(this.client, channel, text, { threadTs })
        } catch (err) {
          console.warn(`[Slack:${this.instanceId}] stream finish failed:`, errMsg(err))
          return undefined
        }
      },
      abort: () => { aborted = true },
    }
  }

  async sendToolNotification(ref: ChannelRef, text: string): Promise<string | undefined> {
    return sendToolNotification(this.client, ref.sourceChannel, text, { threadTs: ref.threadRef })
  }

  async updateToolNotification(ref: ChannelRef, messageId: string, text: string): Promise<void> {
    try {
      await updateToolNotification(this.client, ref.sourceChannel, messageId, text)
    } catch {
      // "not changed" errors are expected
    }
  }

  async fetchAttachmentBytes(
    attachment: IMAttachment,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const ref = attachment.providerRef
    if (!ref || ref.kind !== 'slack-file') {
      throw new Error('Slack fetchAttachmentBytes: missing slack-file providerRef')
    }
    if (!ref.urlPrivate) {
      throw new Error('Slack fetchAttachmentBytes: providerRef.urlPrivate empty')
    }
    const res = await fetch(ref.urlPrivate, {
      headers: { Authorization: `Bearer ${this.botToken}` },
    })
    if (!res.ok) {
      throw new Error(`Slack file fetch failed: ${res.status}`)
    }
    const data = Buffer.from(await res.arrayBuffer())
    return { data, mimeType: attachment.mime ?? 'image/octet-stream' }
  }

  async addReaction(ref: ChannelRef, sourceTs: string, emoji: string): Promise<void> {
    try {
      await this.client.reactions.add({
        channel: ref.sourceChannel,
        timestamp: sourceTs,
        name: emoji,
      })
    } catch (err) {
      const msg = errMsg(err)
      // `already_reacted` is expected on debounced bursts; silence it.
      if (!msg.includes('already_reacted')) {
        console.warn(`[Slack:${this.instanceId}] reactions.add failed:`, msg)
      }
    }
  }

  async sendDiffPreview(ref: ChannelRef, preview: DiffPreview): Promise<void> {
    const blocks: KnownBlock[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `📄 *${preview.fileName}*` },
      },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '📄 View Diff', emoji: true },
          url: preview.viewUrl,
          action_id: 'diff:view',
        }],
      },
    ]
    await this.client.chat.postMessage({
      channel: ref.sourceChannel,
      text: `📄 ${preview.fileName}`,
      blocks,
      ...(ref.threadRef ? { thread_ts: ref.threadRef } : {}),
    })
  }

  resolveTarget(target: string): ChannelRef {
    const parts = target.split(':')
    if (parts[0] !== SOURCE || parts.length < 2) {
      throw new Error(`Invalid slack target: ${target}`)
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
      'Platform: Slack.',
      'Target URI: `slack:<channel-id>[:<thread-ts>]`.',
      'Threads are explicit — to reply in an existing thread, reuse the `target=` string verbatim.',
      'Use plain text or Slack mrkdwn (`*bold*`, `_italic_`, `` `code` ``, `> quote`). No Block Kit.',
      'Mentions: incoming text has already been rewritten so `@<your-name>` means you are being addressed; any `@U...` (raw Slack id) is a participant that is NOT you — do not reply unless explicitly addressed.',
    ].join(' ')
  }

  protected renderChoices(ref: ChannelRef): ChoiceRenderer {
    const channel = ref.sourceChannel
    const threadTs = ref.threadRef

    const trunc = (label: string) =>
      label.length <= MAX_LABEL_LEN ? label : label.slice(0, MAX_LABEL_LEN - 1) + '…'

    const buildBlocks = (view: PageView): Array<Record<string, unknown>> => {
      const { question, choices, nav } = view
      const headerText = nav ? `${question}\n\n_page ${nav.current}/${nav.total}_` : question

      const blocks: Array<Record<string, unknown>> = [
        { type: 'section', text: { type: 'mrkdwn', text: headerText } },
      ]

      for (const c of choices) {
        const label = c.description ? `${c.label} — ${c.description}` : c.label
        blocks.push({
          type: 'actions',
          block_id: `b:${c.actionId}`,
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: trunc(label), emoji: true },
            action_id: c.actionId,
          }],
        })
      }

      if (nav) {
        const navElements: Array<Record<string, unknown>> = []
        if (nav.prev) {
          navElements.push({
            type: 'button',
            text: { type: 'plain_text', text: '◀ Prev' },
            action_id: nav.prev.actionId,
          })
        }
        navElements.push({
          type: 'button',
          text: { type: 'plain_text', text: `${nav.current}/${nav.total}` },
          action_id: `cp:noop:${nav.current - 1}`,
        })
        if (nav.next) {
          navElements.push({
            type: 'button',
            text: { type: 'plain_text', text: 'Next ▶' },
            action_id: nav.next.actionId,
          })
        }
        blocks.push({ type: 'actions', block_id: `bn:${nav.current}`, elements: navElements })
      }

      return blocks
    }

    return {
      send: async (view) => {
        const res = await this.client.chat.postMessage({
          channel,
          text: view.question,
          blocks: buildBlocks(view) as unknown as KnownBlock[],
          ...(threadTs ? { thread_ts: threadTs } : {}),
        })
        return res.ts
      },
      edit: async (messageId, view) => {
        await this.client.chat.update({
          channel,
          ts: messageId,
          text: view.question,
          blocks: buildBlocks(view) as unknown as KnownBlock[],
        }).catch(() => {})
      },
      finalize: async (messageId, label) => {
        await this.client.chat.update({
          channel,
          ts: messageId,
          text: `✅ ${label}`,
          blocks: [],
        }).catch(() => {})
      },
    }
  }

  private isUserAuthorized(userId: string): boolean {
    if (!this.config.allowedUserIds?.length) return true
    return this.config.allowedUserIds.includes(userId)
  }

  private isChannelAuthorized(channelId: string): boolean {
    if (!this.config.allowedChannelIds?.length) return true
    return this.config.allowedChannelIds.includes(channelId)
  }

  private installHandlers(): void {
    this.app.event('message', async ({ event }: SlackEventMiddlewareArgs<'message'>) => {
      const msg = event as unknown as SlackMessageEventRaw
      if (msg.type !== 'message') return
      if (msg.subtype === 'message_changed' || msg.subtype === 'message_deleted') return
      if (!msg.channel || !msg.ts) return
      // Pure-text or pure-file: at least one of text / files must be present.
      if (!msg.text && !msg.files?.length) return

      // Self-echo is NOT filtered here — inbound-pipeline drops it after
      // classifySender so im_messages stays purely an inbox of received
      // messages. See services/agent-comm/im-chat-service.ts.
      const isDM = msg.channel_type === 'im' || msg.channel_type === 'mpim'
      if (isDM) {
        if (!msg.user || !this.isUserAuthorized(msg.user)) return
      } else {
        if (!this.isChannelAuthorized(msg.channel)) return
      }

      const senderId = msg.user ?? msg.bot_id ?? ''
      if (!senderId) return
      const senderName =
        msg.username ??
        msg.bot_profile?.name ??
        (msg.bot_id ? msg.bot_id : 'user')

      const attachments = parseAttachments(msg.files)
      const rawText = msg.text ?? ''
      const text = rawText
        ? cleanText(rawText)
        : attachments.length
          ? '[image]'
          : ''

      this.emit({
        kind: 'message',
        sourceChannel: msg.channel,
        isDM,
        sourceTs: msg.ts,
        senderId,
        senderName,
        senderIsBot: Boolean(msg.bot_id),
        text,
        threadRef: msg.thread_ts,
        replyToRef: msg.thread_ts,
        attachments: attachments.length ? attachments : undefined,
        mentionedUserIds: extractSlackMentions(rawText),
        raw: msg,
      })
    })

    // Choice button clicks (c:*) and pagination (cp:*)
    this.app.action(/^c:/, async ({ ack, action }: SlackActionMiddlewareArgs<BlockAction>) => {
      await ack()
      await this.paginator.dispatch((action as unknown as SlackBlockActionId).action_id)
    })
    this.app.action(/^cp:/, async ({ ack, action }: SlackActionMiddlewareArgs<BlockAction>) => {
      await ack()
      await this.paginator.dispatch((action as unknown as SlackBlockActionId).action_id)
    })
    this.app.action(/^diff:/, async ({ ack }: SlackActionMiddlewareArgs<BlockAction>) => {
      await ack()
    })

    this.app.error(async (err) => {
      console.warn(`[Slack:${this.instanceId}] bolt error:`, errMsg(err))
    })
  }
}

export const slackSourceMeta: IMSourceMeta = {
  source: SOURCE,
  label: 'Slack',
  icon: 'Hash',
  credentialFields: [
    { key: 'botToken', label: 'Bot Token', secret: true, required: true, placeholder: 'xoxb-...' },
    { key: 'appToken', label: 'App Token', secret: true, required: true, placeholder: 'xapp-...' },
  ],
}

export const slackProviderFactory: ProviderFactory = {
  source: SOURCE,
  create(record: IMProviderRecord): IMProvider {
    return new SlackProvider(record)
  },
}

function parseCredentials(raw: string): SlackCredentials {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Slack credentials_json is not valid JSON') }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Slack credentials_json must be an object')
  }
  const obj = parsed as Record<string, unknown>
  const botToken = obj.botToken ?? obj.bot_token
  const appToken = obj.appToken ?? obj.app_token
  if (typeof botToken !== 'string' || typeof appToken !== 'string') {
    throw new Error('Slack credentials require botToken and appToken')
  }
  return { botToken, appToken }
}

function parseConfig(raw: string | null): SlackConfig {
  if (!raw) return {}
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const out: SlackConfig = {}
    if (Array.isArray(obj.allowedUserIds)) {
      out.allowedUserIds = (obj.allowedUserIds as unknown[]).filter((v): v is string => typeof v === 'string')
    }
    if (Array.isArray(obj.allowedChannelIds)) {
      out.allowedChannelIds = (obj.allowedChannelIds as unknown[]).filter((v): v is string => typeof v === 'string')
    }
    return out
  } catch {
    return {}
  }
}

function parseAttachments(files: SlackFileRaw[] | undefined): IMAttachment[] {
  if (!files?.length) return []
  const out: IMAttachment[] = []
  for (const f of files) {
    if (!f.id || !f.url_private) continue
    const mime = f.mimetype
    out.push({
      type: mime?.startsWith('image/') ? 'image' : 'file',
      url: f.url_private,
      mime,
      name: f.name,
      size: f.size,
      providerRef: { kind: 'slack-file', fileId: f.id, urlPrivate: f.url_private },
    })
  }
  return out
}

function cleanText(text: string): string {
  let out = text
  out = out.replace(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g, '@$1')
  out = out.replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2')
  out = out.replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, '$2 ($1)')
  out = out.replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
  return out.trim()
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
