import type { WebClient } from '@slack/web-api'
import { markdownToMrkdwn } from './markdown-to-mrkdwn.js'

const SLACK_MAX_LENGTH = 3500

export interface SendOptions {
  threadTs?: string
}

function splitByLength(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max)
    if (cut < max / 2) cut = remaining.lastIndexOf(' ', max)
    if (cut < max / 2) cut = max
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).replace(/^\s+/, '')
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export async function sendFormattedMessage(
  client: WebClient,
  channel: string,
  markdown: string,
  options: SendOptions = {},
): Promise<string | undefined> {
  const mrkdwn = markdownToMrkdwn(markdown)
  if (!mrkdwn.trim()) return undefined

  const chunks = splitByLength(mrkdwn, SLACK_MAX_LENGTH)
  let lastTs: string | undefined
  for (const chunk of chunks) {
    const res = await client.chat.postMessage({
      channel,
      text: chunk,
      mrkdwn: true,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
    })
    lastTs = res.ts ?? lastTs
  }
  return lastTs
}

export async function sendPlainMessage(
  client: WebClient,
  channel: string,
  text: string,
  options: SendOptions = {},
): Promise<string> {
  const res = await client.chat.postMessage({
    channel,
    text: text.slice(0, SLACK_MAX_LENGTH),
    mrkdwn: false,
    ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
  })
  return res.ts ?? ''
}

export async function postStreamingUpdate(
  client: WebClient,
  channel: string,
  ts: string,
  markdown: string,
): Promise<void> {
  const mrkdwn = markdownToMrkdwn(markdown)
  const truncated = mrkdwn.slice(0, SLACK_MAX_LENGTH - 4) + ' \u258C'
  await client.chat.update({
    channel,
    ts,
    text: truncated,
  })
}

export async function createStreamingMessage(
  client: WebClient,
  channel: string,
  markdown: string,
  options: SendOptions = {},
): Promise<string | undefined> {
  const mrkdwn = markdownToMrkdwn(markdown)
  const truncated = mrkdwn.slice(0, SLACK_MAX_LENGTH - 4) + ' \u258C'
  const res = await client.chat.postMessage({
    channel,
    text: truncated,
    mrkdwn: true,
    ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
  })
  return res.ts
}

export async function finalizeStreamingMessage(
  client: WebClient,
  channel: string,
  ts: string,
  markdown: string,
): Promise<void> {
  const mrkdwn = markdownToMrkdwn(markdown)
  const finalText = mrkdwn.slice(0, SLACK_MAX_LENGTH)
  await client.chat.update({
    channel,
    ts,
    text: finalText,
  })
}

export async function sendToolNotification(
  client: WebClient,
  channel: string,
  text: string,
  options: SendOptions = {},
): Promise<string> {
  const res = await client.chat.postMessage({
    channel,
    text: text.slice(0, SLACK_MAX_LENGTH),
    mrkdwn: true,
    ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
  })
  return res.ts ?? ''
}

export async function updateToolNotification(
  client: WebClient,
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  await client.chat.update({
    channel,
    ts,
    text: text.slice(0, SLACK_MAX_LENGTH),
  })
}
