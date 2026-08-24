import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { OPERON_DATA_DIR } from './operon-runtime/paths.js'

/**
 * Content-addressed store for chat attachments.
 *
 * Attachments used to live inline in the message JSON as `data:` URLs. That put
 * a base64 copy of every image in the DB row, in the chat-history response, in
 * the parsed JS string and in the `<img src>` — and forced the browser to
 * decode the full-size bitmap just to paint a 96px thumbnail. Storing the bytes
 * on disk and referencing them by hash means the transcript carries a ~60 byte
 * URL instead, and the browser can lazily fetch (and cache) the image only when
 * it is actually shown.
 *
 * Addressing by content hash also dedupes for free: re-sending the same
 * screenshot across turns writes one file.
 */

const ATTACHMENTS_DIR = path.join(OPERON_DATA_DIR, 'attachments')

/** Attachment hashes are sha256 hex — validated before touching the filesystem. */
const HASH_PATTERN = /^[a-f0-9]{64}$/

export interface AttachmentMeta {
  mediaType: string
  filename?: string
  sizeBytes: number
}

export interface StoredAttachment extends AttachmentMeta {
  hash: string
  /** Relative URL the UI puts in the file part's `url`. */
  url: string
}

/** `<dir>/ab/cd/abcd…` — sharded so one directory never holds every attachment. */
const blobPathFor = (hash: string): string =>
  path.join(ATTACHMENTS_DIR, hash.slice(0, 2), hash.slice(2, 4), hash)

const metaPathFor = (hash: string): string => `${blobPathFor(hash)}.json`

export const attachmentUrlFor = (hash: string): string => `/api/attachments/${hash}`

/**
 * Extracts the hash from a URL this store produced. Returns null for anything
 * else (`data:`, `file://`, remote URLs), so callers can pass through untouched
 * attachments — including transcripts written before this store existed.
 */
export const parseAttachmentUrl = (url: string): string | null => {
  const match = /^(?:\/api\/attachments\/)([a-f0-9]{64})$/.exec(url)
  return match ? match[1] : null
}

/** Writes bytes under their content hash. Re-storing identical bytes is a no-op. */
export function putAttachment(
  data: Buffer,
  meta: { mediaType: string; filename?: string },
): StoredAttachment {
  const hash = crypto.createHash('sha256').update(data).digest('hex')
  const blobPath = blobPathFor(hash)

  if (!fs.existsSync(blobPath)) {
    fs.mkdirSync(path.dirname(blobPath), { recursive: true })
    // Write-then-rename so a crash mid-write can't leave a truncated blob at a
    // hash that claims to describe complete content.
    const tmpPath = `${blobPath}.${process.pid}.tmp`
    fs.writeFileSync(tmpPath, data)
    fs.renameSync(tmpPath, blobPath)
  }

  const stored: AttachmentMeta = {
    mediaType: meta.mediaType,
    filename: meta.filename,
    sizeBytes: data.byteLength,
  }
  fs.writeFileSync(metaPathFor(hash), JSON.stringify(stored))

  return { ...stored, hash, url: attachmentUrlFor(hash) }
}

/** Reads an attachment's bytes and metadata, or undefined if it isn't stored. */
export function getAttachment(hash: string): { data: Buffer; meta: AttachmentMeta } | undefined {
  if (!HASH_PATTERN.test(hash)) return undefined

  const blobPath = blobPathFor(hash)
  if (!fs.existsSync(blobPath)) return undefined

  const data = fs.readFileSync(blobPath)

  let meta: AttachmentMeta = { mediaType: 'application/octet-stream', sizeBytes: data.byteLength }
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPathFor(hash), 'utf8')) as Partial<AttachmentMeta>
    if (typeof parsed.mediaType === 'string') {
      meta = {
        mediaType: parsed.mediaType,
        filename: typeof parsed.filename === 'string' ? parsed.filename : undefined,
        sizeBytes: data.byteLength,
      }
    }
  } catch {
    // Missing/corrupt sidecar — serve the bytes with a generic type rather than
    // 404ing content we demonstrably have.
  }

  return { data, meta }
}

/**
 * Stores the payload of a `data:` URL. Returns null when the string isn't a
 * parseable base64 data URL, so callers can leave it alone.
 */
export function putDataUrl(dataUrl: string, filename?: string): StoredAttachment | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return null

  const [, mediaType, base64Marker, payload] = match
  try {
    const data = base64Marker
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
    if (data.byteLength === 0) return null
    return putAttachment(data, { mediaType, filename })
  } catch {
    return null
  }
}
