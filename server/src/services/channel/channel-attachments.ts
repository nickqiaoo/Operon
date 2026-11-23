/**
 * Images on channel messages.
 *
 * They live in the attachment store like every other image (a chat's file part,
 * a board task's), referenced by `/api/attachments/<sha256>`. Three ways in and
 * out for agents, none of them a tool of their own:
 *
 *   - a turn an agent is woken for gets the images as file parts, so the model
 *     sees them directly (`channelAttachmentFiles`);
 *   - a message read later (check_messages, read_history) names each image by a
 *     local path the agent opens with its own file-reading tool
 *     (`localImagePath`) — with an extension, because the store names blobs by
 *     hash alone and readers decide "this is an image" from the extension;
 *   - an agent attaches its own images by passing local paths to send_message
 *     (`storeLocalImages`): the people reading the channel are on other
 *     devices, so the bytes have to be copied into the store.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { FileUIPart } from 'ai'
import type { ChannelAttachment } from '../../types/channel.js'
import { attachmentBlobPath, parseAttachmentUrl, putAttachment } from '../attachment-store.js'
import { sanitizeTaskAttachments, taskAttachmentFiles } from '../task-attachments.js'

/** At most this many images on one message. */
export const MAX_MESSAGE_IMAGES = 10
/** An agent's local image larger than this is refused rather than copied. */
const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/avif': 'avif',
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  heic: 'image/heic',
  avif: 'image/avif',
}

/** Images a client attached: only stored images survive (no remote / data: URLs). */
export function sanitizeChannelAttachments(raw: unknown): ChannelAttachment[] {
  return sanitizeTaskAttachments(raw).filter((attachment) => {
    const hash = parseAttachmentUrl(attachment.url)
    const blob = hash && attachmentBlobPath(hash)
    return blob != null && fs.existsSync(blob)
  }).slice(0, MAX_MESSAGE_IMAGES)
}

/** The images as file parts, for the turn an agent is woken with. */
export function channelAttachmentFiles(attachments: ChannelAttachment[]): FileUIPart[] {
  return taskAttachmentFiles(attachments)
}

/**
 * A path to the image with a proper extension, for an agent to open with its
 * own tools. A hard link next to the store's blobs (a copy where linking
 * fails), made once per image. Null when the image is not in the store.
 */
export function localImagePath(attachment: ChannelAttachment): string | null {
  const hash = parseAttachmentUrl(attachment.url)
  if (!hash) return null
  const blob = attachmentBlobPath(hash)
  if (!blob || !fs.existsSync(blob)) return null
  const ext = EXTENSION_BY_TYPE[attachment.mediaType.toLowerCase()] ?? 'png'
  const readable = path.join(path.dirname(blob), `${hash}.${ext}`)
  if (!fs.existsSync(readable)) {
    try {
      fs.linkSync(blob, readable)
    } catch {
      try {
        fs.copyFileSync(blob, readable)
      } catch {
        return null
      }
    }
  }
  return readable
}

/**
 * Copy an agent's local image files into the attachment store. Throws with a
 * message for the agent when a path is not an absolute path to a readable
 * image file of a reasonable size.
 */
export function storeLocalImages(paths: string[]): ChannelAttachment[] {
  if (paths.length > MAX_MESSAGE_IMAGES) throw new Error(`At most ${MAX_MESSAGE_IMAGES} images per message.`)
  return paths.map((p) => {
    if (!path.isAbsolute(p)) throw new Error(`Image path must be absolute: ${p}`)
    const ext = path.extname(p).slice(1).toLowerCase()
    const mediaType = TYPE_BY_EXTENSION[ext]
    if (!mediaType) throw new Error(`Not an image file (png, jpg, gif, webp, svg, bmp, heic, avif): ${p}`)
    let stat: fs.Stats
    try {
      stat = fs.statSync(p)
    } catch {
      throw new Error(`Image not found: ${p}`)
    }
    if (!stat.isFile()) throw new Error(`Not a file: ${p}`)
    if (stat.size > MAX_LOCAL_IMAGE_BYTES) throw new Error(`Image is larger than ${MAX_LOCAL_IMAGE_BYTES / 1024 / 1024} MB: ${p}`)
    const stored = putAttachment(fs.readFileSync(p), { mediaType, filename: path.basename(p) })
    return { url: stored.url, mediaType, filename: path.basename(p) }
  })
}
