import { apiAuthHeaders, getBaseUrl, getBaseUrlSync, withApiTokenQuery } from './api-client'

/**
 * Client side of the content-addressed attachment store.
 *
 * Attachments travel through the transcript as the node-relative path
 * `/api/attachments/<sha256>` rather than an absolute URL, because the absolute
 * one isn't stable: the desktop server binds a fresh port each launch, and the
 * web client reaches the same file through `<broker>/u/<user>/n/<node>/api`.
 * Storing a resolved URL would break the image the next time either changed.
 * Resolution therefore happens at render time, against the current base URL.
 */

const ATTACHMENT_PATH = /^\/api\/attachments\/[a-f0-9]{64}$/

export const isAttachmentUrl = (url: string | undefined): boolean =>
  !!url && ATTACHMENT_PATH.test(url)

/** Absolute URL for an attachment path, or null if the base URL isn't known yet. */
export function resolveAttachmentUrl(url: string): string | null {
  if (!isAttachmentUrl(url)) return url
  const baseUrl = getBaseUrlSync()
  // `baseUrl` already ends in `/api`, which the stored path repeats. These URLs
  // land in <img src>, which cannot carry headers — on desktop the api token
  // rides the query instead (no-op on web, where the broker path is used).
  return baseUrl ? withApiTokenQuery(`${baseUrl}${url.replace(/^\/api/, '')}`) : null
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
): Promise<UploadedAttachment | null> {
  try {
    const blob = await (await fetch(blobUrl)).blob()
    const filename = meta?.filename || 'attachment'
    const file = new File([blob], filename, { type: meta?.mediaType || blob.type })

    const body = new FormData()
    body.append('file', file)

    const baseUrl = await getBaseUrl()
    // No Content-Type header: the browser has to set the multipart boundary.
    const res = await fetch(`${baseUrl}/attachments`, { method: 'POST', body, headers: apiAuthHeaders() })
    if (!res.ok) return null

    return (await res.json()) as UploadedAttachment
  } catch {
    return null
  }
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
): Promise<string | null> {
  const uploaded = await uploadBlobUrl(blobUrl, meta)
  if (uploaded) return uploaded.url
  return blobUrlToDataUrl(blobUrl)
}
