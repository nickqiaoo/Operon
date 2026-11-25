/** 80pt tiles at 3x. */
const THUMBNAIL_PX = 240
const thumbnails = new Map<string, string>()
const pendingThumbnails = new Map<string, Promise<string | undefined>>()

export function getAttachmentThumbnail(url: string) {
  return thumbnails.get(url)
}

function rememberThumbnail(url: string, thumbnail: string) {
  thumbnails.set(url, thumbnail)
  if (thumbnails.size > 128) {
    const oldest = thumbnails.keys().next()
    if (!oldest.done) thumbnails.delete(oldest.value)
  }
}

export function linkAttachmentThumbnail(source: string, stored: string) {
  const thumbnail = thumbnails.get(source)
  if (thumbnail) rememberThumbnail(stored, thumbnail)
}

/**
 * A center-cropped square JPEG of an image attachment, small enough to cross
 * the bridge with every composer update (~15KB). UIKit cannot read the page's
 * `blob:` URLs, so the page draws it. Cached by source URL.
 */
export function composerThumbnail(url: string): Promise<string | undefined> {
  const cached = thumbnails.get(url)
  if (cached) return Promise.resolve(cached)
  let pending = pendingThumbnails.get(url)
  if (!pending) {
    pending = new Promise<string | undefined>((resolve) => {
      const img = new Image()
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight)
        if (side === 0) return resolve(undefined)
        const size = Math.min(THUMBNAIL_PX, side)
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) return resolve(undefined)
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size)
        resolve(canvas.toDataURL('image/jpeg', 0.8))
      }
      img.onerror = () => resolve(undefined)
      img.src = url
    })
    pending = pending.then((thumbnail) => {
      if (thumbnail) rememberThumbnail(url, thumbnail)
      return thumbnail
    }).finally(() => pendingThumbnails.delete(url))
    pendingThumbnails.set(url, pending)
  }
  return pending
}
