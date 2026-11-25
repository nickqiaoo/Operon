import { linkAttachmentThumbnail } from './attachment-thumbnails'
import { localTransport, type ApiTransport } from './api-client'

/**
 * Client side of the content-addressed attachment store.
 *
 * Attachments travel through the transcript as the node-relative path
 * `/api/attachments/<sha256>` rather than an absolute URL, because the absolute
 * one isn't stable: the desktop server binds a fresh port each launch, and the
 * web client reaches the same file through `<broker>/u/<user>/n/<node>/api`.
 * Storing a resolved URL would break the image the next time either changed.
 * Resolution therefore happens at render time, against the current base URL.
 *
 * The path is relative to the machine the conversation lives on, so every
 * function here takes that machine's transport (`useChatTransport()`); this
 * machine by default.
 */

const ATTACHMENT_PATH = /^\/api\/attachments\/[a-f0-9]{64}$/

export const isAttachmentUrl = (url: string | undefined): boolean =>
  !!url && ATTACHMENT_PATH.test(url)

/** Absolute URL for an attachment path, or null if the base URL isn't known yet. */
export function resolveAttachmentUrl(url: string, transport: ApiTransport = localTransport): string | null {
  if (!isAttachmentUrl(url)) return url
  const baseUrl = transport.baseUrlSync()
  // `baseUrl` already ends in `/api`, which the stored path repeats. These URLs
  // land in <img src>, which cannot carry headers — on desktop the api token
  // rides the query instead (no-op on web, where the broker path is used).
  return baseUrl ? transport.withTokenQuery(`${baseUrl}${url.replace(/^\/api/, '')}`) : null
}

export interface UploadedAttachment {
  hash: string
  url: string
  mediaType: string
  filename?: string
  sizeBytes: number
}

/**
 * Uploads the bytes behind a `blob:` URL and returns the stored attachment.
 *
 * Returns null on any failure so callers can fall back to inlining a data URL —
 * a degraded transcript is worth far more than refusing to send the message
 * because the attachment store was unreachable.
 */
export async function uploadBlobUrl(
  blobUrl: string,
  meta?: { filename?: string; mediaType?: string },
  transport: ApiTransport = localTransport,
): Promise<UploadedAttachment | null> {
  try {
    const blob = await (await fetch(blobUrl)).blob()
    const filename = meta?.filename || 'attachment'
    return await uploadFile(new File([blob], filename, { type: meta?.mediaType || blob.type }), transport)
  } catch {
    return null
  }
}

/** Uploads a file (a pasted or dropped image, say) to the attachment store. Null on any failure. */
export async function uploadFile(
  file: File,
  transport: ApiTransport = localTransport,
): Promise<UploadedAttachment | null> {
  try {
    const body = new FormData()
    body.append('file', file)

    const baseUrl = await transport.baseUrl()
    // No Content-Type header: the browser has to set the multipart boundary.
    const res = await fetch(`${baseUrl}/attachments`, { method: 'POST', body, headers: transport.authHeaders() })
    if (!res.ok) return null

    return (await res.json()) as UploadedAttachment
  } catch {
    return null
  }
}

/**
 * Uploads begun when a file was attached, by machine and `blob:` URL. A failed
 * one is dropped so a send can try again.
 */
const startedUploads = new Map<string, Promise<UploadedAttachment | null>>()
const uploadKey = (blobUrl: string, transport: ApiTransport) => `${transport.nodeId ?? ''}|${blobUrl}`

/**
 * Starts uploading a file as soon as it is attached, so that sending has little
 * or nothing left to wait for. Safe to call repeatedly for the same URL. The
 * store is content-addressed, so a file removed again before sending costs one
 * stored blob and nothing else.
 */
export function preuploadBlobUrl(
  blobUrl: string,
  meta?: { filename?: string; mediaType?: string },
  transport: ApiTransport = localTransport,
): void {
  const key = uploadKey(blobUrl, transport)
  if (startedUploads.has(key)) return
  const upload = uploadBlobUrl(blobUrl, meta, transport).then((uploaded) => {
    if (!uploaded) startedUploads.delete(key)
    return uploaded
  })
  startedUploads.set(key, upload)
}

/** Legacy fallback: inline a `blob:` URL as a base64 data URL. */
export async function blobUrlToDataUrl(blobUrl: string): Promise<string | null> {
  try {
    const blob = await (await fetch(blobUrl)).blob()
    return await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/**
 * Turns a `blob:` URL into what should be persisted in the message: an
 * attachment path when the upload succeeds, an inline data URL when it doesn't.
 */
export async function persistBlobUrl(
  blobUrl: string,
  meta?: { filename?: string; mediaType?: string },
  transport: ApiTransport = localTransport,
): Promise<string | null> {
  const uploaded = await (startedUploads.get(uploadKey(blobUrl, transport)) ?? uploadBlobUrl(blobUrl, meta, transport))
  if (uploaded) {
    linkAttachmentThumbnail(blobUrl, uploaded.url)
    return uploaded.url
  }
  return blobUrlToDataUrl(blobUrl)
}
