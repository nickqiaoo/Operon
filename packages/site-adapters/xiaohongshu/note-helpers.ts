/** Side-effect-free helpers shared by the note, comments and download commands. */

import { ArgumentError } from "../errors.ts"

/** Extract a bare note ID from a full URL or raw ID string. */
export function parseNoteId(input: string): string {
  const trimmed = input.trim()
  const match = trimmed.match(
    /\/(?:explore|note|search_result|discovery\/item)\/([a-f0-9]+)|\/user\/profile\/[^/?#]+\/([a-f0-9]+)/i,
  )
  return match ? (match[1] || match[2] || trimmed) : trimmed
}

export const XHS_SIGNED_URL_HINT =
  "Pass a full Xiaohongshu note URL with xsec_token from search results or user/profile context."

function isShortLink(input: string): boolean {
  return /^https?:\/\/xhslink\.com\//i.test(input)
}

function isHostMatch(hostname: string, cookieRoot: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === cookieRoot || normalized.endsWith("." + cookieRoot)
}

function isSupportedNotePath(pathname: string): boolean {
  return (
    /^\/(?:explore|note|search_result|discovery\/item)\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname) ||
    /^\/user\/profile\/[^/?#]+\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname)
  )
}

/**
 * Note detail pages only resolve reliably from a signed URL, so callers must
 * pass a full note URL with `xsec_token` (or, for downloads, an xhslink short
 * link). Bare note IDs are rejected.
 */
export function buildNoteUrl(
  input: string,
  options: { allowShortLink?: boolean; commandName?: string } = {},
): string {
  const { allowShortLink = false, commandName = "xiaohongshu.note" } = options
  const trimmed = input.trim()
  const message = `${commandName} requires a full signed note URL`
  const hint = allowShortLink
    ? `${XHS_SIGNED_URL_HINT} For downloads, xhslink short links are also supported.`
    : XHS_SIGNED_URL_HINT

  if (/^https?:\/\//.test(trimmed)) {
    if (isShortLink(trimmed)) {
      if (allowShortLink) return trimmed
      throw new ArgumentError(message, hint)
    }
    try {
      const url = new URL(trimmed)
      const xsecToken = url.searchParams.get("xsec_token")?.trim()
      if (isHostMatch(url.hostname, "xiaohongshu.com") && isSupportedNotePath(url.pathname) && xsecToken) {
        return trimmed
      }
    } catch {
      // fall through to the argument error
    }
  }
  throw new ArgumentError(message, hint)
}
