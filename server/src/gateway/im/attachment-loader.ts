import type { IMAttachment, IMProvider } from './types.js'

export const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024

export interface LoadedImage {
  attachment: IMAttachment
  data: Buffer
  mimeType: string
}

export type DroppedReason = 'non-image' | 'no-fetcher' | 'over-budget' | 'fetch-failed'

export interface DroppedImage {
  attachment: IMAttachment
  reason: DroppedReason
}

export interface AttachmentLoadResult {
  loaded: LoadedImage[]
  dropped: DroppedImage[]
  bytesUsed: number
}

/**
 * Lazy-fetch image attachments from a provider, capped at `budgetBytes`.
 *
 * Sequential download (per-message image counts are typically small and
 * mixed concurrency makes per-image error attribution noisy). Failures on a
 * single attachment do not halt the batch — the bad image is recorded as
 * `dropped(reason='fetch-failed')` and the next one continues.
 *
 * Non-image attachments are short-circuited as `dropped(reason='non-image')`
 * so callers can render placeholder text without trying to fetch them.
 */
export async function loadInlineImages(
  provider: IMProvider,
  attachments: ReadonlyArray<IMAttachment>,
  budgetBytes: number = MAX_INLINE_IMAGE_BYTES,
): Promise<AttachmentLoadResult> {
  const loaded: LoadedImage[] = []
  const dropped: DroppedImage[] = []
  let bytesUsed = 0

  for (const att of attachments) {
    if (att.type !== 'image') {
      dropped.push({ attachment: att, reason: 'non-image' })
      continue
    }
    if (typeof provider.fetchAttachmentBytes !== 'function') {
      dropped.push({ attachment: att, reason: 'no-fetcher' })
      continue
    }
    if (bytesUsed >= budgetBytes) {
      dropped.push({ attachment: att, reason: 'over-budget' })
      continue
    }

    try {
      const { data, mimeType } = await provider.fetchAttachmentBytes(att)
      if (bytesUsed + data.length > budgetBytes) {
        dropped.push({ attachment: att, reason: 'over-budget' })
        continue
      }
      bytesUsed += data.length
      loaded.push({ attachment: att, data, mimeType })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[attachment-loader] fetch failed for ${att.name ?? att.url}: ${msg}`,
      )
      dropped.push({ attachment: att, reason: 'fetch-failed' })
    }
  }

  return { loaded, dropped, bytesUsed }
}
