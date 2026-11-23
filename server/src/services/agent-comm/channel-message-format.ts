import type { ChannelMessage } from '../../types/channel.js'
import { localImagePath } from '../channel/channel-attachments.js'

/** Convert a message id to an 8-char hex short id (used in target format). */
export function toShortId(id: number): string {
  return id.toString(16).padStart(8, '0')
}

/** Parse an 8-char hex short id back to a numeric id. */
export function fromShortId(s: string): number {
  return parseInt(s, 16)
}

/** Convert ISO to local time string for display (matches slock). */
function toLocalTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * The desktop client posts as `you` — fine on screen, but to an agent reading
 * `sender=you` it means *itself* (agents took the human's "hi" for their own
 * message). Anonymous humans show as `user`, as the system prompt documents.
 */
function senderLabel(msg: ChannelMessage): string {
  if (msg.senderType === 'human' && (msg.senderName === 'you' || !msg.senderName.trim())) return 'user'
  return msg.senderName
}

/**
 * Format a message in RFC-5424-inspired envelope style:
 *   [target=#general msg=a1b2c3d4 time=... sender=Alice type=user] content
 *
 * All sender metadata lives inside the bracketed header. `@` in the content is
 * reserved for real mentions. `content` overrides the body (e.g. a truncated
 * excerpt) while keeping the header intact.
 */
export function formatChannelMessage(msg: ChannelMessage, channelName: string, content = msg.content): string {
  const shortId = toShortId(msg.id)
  const parentTarget = msg.threadRootId
    ? `#${channelName}:${toShortId(msg.threadRootId)}`
    : `#${channelName}`
  const time = toLocalTime(new Date(msg.createdAt).toISOString())
  const type = msg.senderType === 'human' ? 'user' : msg.senderType
  return `[target=${parentTarget} msg=${shortId} time=${time} sender=${senderLabel(msg)} type=${type}] ${content}${imageLines(msg)}`
}

/** Each attached image as a local path the agent can open with its own file-reading tool. */
function imageLines(msg: ChannelMessage): string {
  if (!msg.attachments || msg.attachments.length === 0) return ''
  return msg.attachments
    .map((a) => {
      const local = localImagePath(a)
      return local ? `\n[image: ${local}]` : `\n[image: ${a.filename ?? 'unavailable'} (not on this machine)]`
    })
    .join('')
}
