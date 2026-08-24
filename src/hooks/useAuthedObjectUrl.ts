import { useEffect, useState } from 'react'

/**
 * Loads a URL that needs the broker's `Authorization: Bearer` header and hands
 * back a `blob:` URL an `<img>` can use.
 *
 * The web client authenticates by monkey-patching `window.fetch` (see
 * `installFetchAuthInterceptor` in lib/web-auth.ts). A browser loading `<img
 * src>` never goes through that patch — it's a native subresource request — so
 * the header is absent and the broker answers 401 before the request ever
 * reaches the node. Same shape as the WebSocket problem, which is why the WS
 * path smuggles the token through `Sec-WebSocket-Protocol` instead.
 *
 * Fetching the bytes ourselves puts the request back on the intercepted
 * `window.fetch`, so it inherits the bearer header AND the 401-refresh-retry.
 *
 * Pass null for anything that doesn't need this (desktop, data:/blob:/http
 * URLs) and the hook stays inert.
 */
export function useAuthedObjectUrl(url: string | null): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(() =>
    url ? (peek(url) ?? null) : null,
  )

  useEffect(() => {
    if (!url) {
      setObjectUrl(null)
      return
    }
    let active = true
    const entry = acquire(url)
    void entry.promise.then((resolved) => {
      if (active) setObjectUrl(resolved)
    })
    return () => {
      active = false
      release(url)
    }
  }, [url])

  return url ? objectUrl : null
}

interface CacheEntry {
  refs: number
  objectUrl: string | null
  promise: Promise<string | null>
}

/**
 * One download per URL, however many components show it. The same attachment
 * routinely appears more than once (the thumbnail and its zoom dialog, the same
 * image re-sent in a later message), and each `createObjectURL` pins a full copy
 * of the bytes in memory until it's revoked.
 */
const cache = new Map<string, CacheEntry>()

/** Already-resolved object URL, for a first render without a null frame. */
function peek(url: string): string | null | undefined {
  return cache.get(url)?.objectUrl
}

function acquire(url: string): CacheEntry {
  const existing = cache.get(url)
  if (existing) {
    existing.refs++
    return existing
  }
  const entry: CacheEntry = {
    refs: 1,
    objectUrl: null,
    // Assigned immediately below; the promise callback needs `entry` in scope.
    promise: Promise.resolve(null),
  }
  entry.promise = download(url).then((resolved) => {
    // A caller that unmounted before the download landed already released its
    // ref, so nothing would ever revoke this one — drop it now instead.
    if (entry.refs === 0 && resolved) {
      URL.revokeObjectURL(resolved)
      return null
    }
    entry.objectUrl = resolved
    return resolved
  })
  cache.set(url, entry)
  return entry
}

function release(url: string): void {
  const entry = cache.get(url)
  if (!entry) return
  entry.refs--
  if (entry.refs > 0) return
  cache.delete(url)
  void entry.promise.then((resolved) => {
    if (resolved) URL.revokeObjectURL(resolved)
  })
}

/** Null on any failure — the caller falls back to its icon rather than a broken image. */
async function download(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return URL.createObjectURL(await res.blob())
  } catch {
    return null
  }
}
