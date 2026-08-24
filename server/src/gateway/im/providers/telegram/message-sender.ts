import type { Bot } from 'gramio'
import { splitMessage } from '@gramio/split'
import { getFormattable } from '@gramio/format'
import { markdownToTelegramEntities, type MessageEntity } from './markdown-to-entities.js'

const TG_MAX_LENGTH = 4096

interface SendOptions {
  messageThreadId?: number
  replyToMessageId?: number
  draftId?: number
}

/** Convert our entity types to Telegram API entity format */
function toTelegramEntities(entities: MessageEntity[]) {
  return entities.map((e) => {
    const base: Record<string, unknown> = {
      type: e.type,
      offset: e.offset,
      length: e.length,
    }
    if (e.type === 'text_link' && e.url) base.url = e.url
    if (e.type === 'pre' && e.language) base.language = e.language
    return base
  })
}

/** Send a markdown message, auto-split if exceeds 4096 chars */
export async function sendFormattedMessage(
  bot: Bot,
  chatId: number,
  markdown: string,
  options: SendOptions = {},
): Promise<number | undefined> {
  const parsed = markdownToTelegramEntities(markdown)
  if (!parsed.text.trim()) return undefined
  const tgEntities = toTelegramEntities(parsed.entities)

  const msg = getFormattable(parsed.text)
  msg.entities = tgEntities as unknown as typeof msg.entities

  let lastMessageId: number | undefined

  await splitMessage(
    msg,
    async ({ text, entities }) => {
      const result = await bot.api.sendMessage({
        chat_id: chatId,
        text,
        entities: entities as typeof msg.entities,
        ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
        ...(options.replyToMessageId && !lastMessageId ? { reply_parameters: { message_id: options.replyToMessageId } } : {}),
      })
      lastMessageId = result.message_id
      return result
    },
    TG_MAX_LENGTH,
  )

  return lastMessageId
}

/** Send a plain text message (no markdown parsing) */
export async function sendPlainMessage(
  bot: Bot,
  chatId: number,
  text: string,
  options: SendOptions = {},
): Promise<number> {
  const result = await bot.api.sendMessage({
    chat_id: chatId,
    text,
    ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
  })
  return result.message_id
}

/** Send a streaming draft update */
export async function sendDraftUpdate(
  bot: Bot,
  chatId: number,
  markdown: string,
  options: SendOptions = {},
): Promise<void> {
  // For draft, truncate to TG_MAX_LENGTH (draft is transient)
  const parsed = markdownToTelegramEntities(markdown)
  const truncatedText = parsed.text.slice(0, TG_MAX_LENGTH - 10) // leave room for cursor
  const cursorText = truncatedText + ' \u258C' // ▌ cursor

  // Filter entities that fit within truncated text
  const validEntities = parsed.entities
    .filter((e) => e.offset < truncatedText.length)
    .map((e) => ({
      ...e,
      length: Math.min(e.length, truncatedText.length - e.offset),
    }))

  const tgEntities = toTelegramEntities(validEntities)

  try {
    await bot.api.sendMessageDraft({
      chat_id: chatId,
      draft_id: options.draftId || 1,
      text: cursorText,
      entities: tgEntities as never,
      ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
    })
  } catch (err: unknown) {
    // Fallback: sendMessageDraft may not be available
    // Silently ignore - the final sendMessage will deliver the content
    const errMsg = err instanceof Error ? err.message : String(err)
    if (!errMsg.includes('TEXTDRAFT_PEER_INVALID') && !errMsg.includes('unknown method')) {
      console.warn('[TG:Draft] sendMessageDraft failed:', errMsg)
    }
  }
}

/** Send a tool notification message */
export async function sendToolNotification(
  bot: Bot,
  chatId: number,
  text: string,
  options: SendOptions = {},
): Promise<number> {
  const parsed = markdownToTelegramEntities(text)
  const truncatedText = parsed.text.slice(0, TG_MAX_LENGTH)
  const validEntities = parsed.entities
    .filter((e) => e.offset < truncatedText.length)
    .map((e) => ({
      ...e,
      length: Math.min(e.length, truncatedText.length - e.offset),
    }))
  const tgEntities = toTelegramEntities(validEntities)

  const result = await bot.api.sendMessage({
    chat_id: chatId,
    text: truncatedText,
    entities: tgEntities as never,
    ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
  })
  return result.message_id
}

