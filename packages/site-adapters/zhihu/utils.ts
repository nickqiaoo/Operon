import type { AdapterPage } from "../types.ts"

export function stripHtml(html: unknown, { preserveBlocks = false } = {}): string {
  if (!html) return ""
  let text = String(html)
  if (preserveBlocks) {
    text = text
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(?:p|div|h[1-6]|li|blockquote)>/gi, "\n\n")
  }
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function parseZhihuUser(input: unknown): string {
  const value = String(input ?? "").trim()
  if (!value) throw new Error("zhihu: user is required")
  const prefix = value.match(/^user:([A-Za-z0-9_-]+)$/)
  if (prefix?.[1]) return prefix[1]
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value
  try {
    const url = new URL(value)
    if (url.protocol === "https:" && (url.hostname === "www.zhihu.com" || url.hostname === "zhihu.com")) {
      const m = url.pathname.match(/^\/people\/([A-Za-z0-9_-]+)\/?$/)
      if (m?.[1]) return m[1]
    }
  } catch {
    // fall through
  }
  throw new Error(`zhihu: invalid user ${value}`)
}

export function validateLimit(raw: unknown, fallback = 20, max = 200): number {
  const value = raw ?? fallback
  const limit = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(limit) || limit <= 0 || limit > max) {
    throw new Error(`zhihu: limit must be 1..${max}`)
  }
  return limit
}

export async function zhihuFetchJson(page: AdapterPage, url: string): Promise<unknown> {
  return page.evaluate(`
    (async () => {
      try {
        const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
        if (!r.ok) return { __httpError: r.status };
        return await r.json();
      } catch (err) {
        return { __fetchError: err?.message || String(err) };
      }
    })()
  `)
}

export function assertOk(data: unknown, label: string): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`zhihu ${label}: malformed payload`)
  }
  const rec = data as Record<string, unknown>
  if (rec.__httpError) {
    const status = rec.__httpError
    if (status === 401 || status === 403) throw new Error(`zhihu ${label}: login required (HTTP ${status})`)
    if (status === 404) throw new Error(`zhihu ${label}: not found`)
    throw new Error(`zhihu ${label}: HTTP ${status}`)
  }
  if (rec.__fetchError) throw new Error(`zhihu ${label}: ${String(rec.__fetchError)}`)
  return rec
}

/** Paginate Zhihu list endpoints following paging.next. */
export async function fetchZhihuList(
  page: AdapterPage,
  firstUrl: string,
  limit: number,
  label: string,
): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = []
  const visited = new Set<string>()
  let url: string | null = firstUrl
  while (url && items.length < limit && !visited.has(url)) {
    visited.add(url)
    const data = assertOk(await zhihuFetchJson(page, url), label)
    const batch = Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : []
    for (const item of batch) {
      items.push(item)
      if (items.length >= limit) break
    }
    const paging = (data.paging ?? {}) as Record<string, unknown>
    if (paging.is_end) break
    const next = typeof paging.next === "string" ? paging.next : ""
    if (!next || next === url) break
    // Normalize api.zhihu.com → www.zhihu.com/api/v4
    try {
      const u: URL = new URL(next)
      if (u.hostname === "api.zhihu.com") {
        url = `https://www.zhihu.com/api/v4${u.pathname}${u.search}`
      } else {
        url = next
      }
    } catch {
      break
    }
  }
  return items
}
