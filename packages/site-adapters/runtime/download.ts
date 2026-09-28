/**
 * Media download (OpenCLI `download/index.ts` + `download/media-download.ts`).
 *
 * Runs on the host: adapters extract media URLs in the page, then this streams
 * each one to disk. Files are written to `<name>.tmp` and renamed on success so
 * a failed transfer never leaves a truncated file under the final name.
 *
 * No yt-dlp route: the sites ported so far serve direct CDN URLs.
 */

import { createWriteStream } from "node:fs"
import { mkdir, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as WebReadableStream } from "node:stream/web"

import { errorMessage } from "../errors.ts"

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"

export interface HttpDownloadOptions {
  headers?: Record<string, string>
  /** Cookie header value; dropped when a redirect leaves the original host. */
  cookies?: string
  timeoutMs?: number
  maxRedirects?: number
}

export interface HttpDownloadResult {
  success: boolean
  size: number
  /** Response `Content-Type` without parameters, when the server sent one. */
  contentType?: string
  error?: string
}

export async function httpDownload(
  url: string,
  destPath: string,
  options: HttpDownloadOptions = {},
  redirectCount = 0,
): Promise<HttpDownloadResult> {
  const { cookies, headers = {}, timeoutMs = 30_000, maxRedirects = 10 } = options
  const requestHeaders: Record<string, string> = { "User-Agent": USER_AGENT, ...headers }
  if (cookies) requestHeaders.Cookie = cookies

  const tempPath = `${destPath}.tmp`
  const cleanup = () => rm(tempPath, { force: true }).catch(() => {})
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
      redirect: "manual",
    })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (location) {
        if (redirectCount >= maxRedirects) {
          return { success: false, size: 0, error: `Too many redirects (> ${maxRedirects})` }
        }
        const next = new URL(location, url).toString()
        const sameHost = new URL(url).hostname === new URL(next).hostname
        const nextOptions = sameHost ? options : { ...options, cookies: undefined, headers: stripCookie(headers) }
        return httpDownload(next, destPath, nextOptions, redirectCount + 1)
      }
    }
    if (response.status !== 200) return { success: false, size: 0, error: `HTTP ${response.status}` }
    if (!response.body) return { success: false, size: 0, error: "Empty response body" }

    let received = 0
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        callback(null, chunk)
      },
    })
    try {
      await mkdir(path.dirname(destPath), { recursive: true })
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream),
        counter,
        createWriteStream(tempPath),
      )
      await rename(tempPath, destPath)
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
      return { success: true, size: received, ...(contentType ? { contentType } : {}) }
    } catch (err) {
      await cleanup()
      return { success: false, size: 0, error: errorMessage(err) }
    }
  } catch (err) {
    await cleanup()
    return { success: false, size: 0, error: errorMessage(err) }
  } finally {
    clearTimeout(timer)
  }
}

function stripCookie(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "cookie"))
}

export function sanitizeFilename(name: string, maxLength = 200): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, maxLength)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/**
 * Where downloads land when the caller gives no directory. The kernel's cwd is
 * the app's, not the user's, so a relative default would be invisible to them.
 */
export function defaultDownloadDir(site: string): string {
  return path.join(os.homedir(), "Downloads", "operon", site)
}

/** `~/x` and relative paths resolve against the home directory. */
export function resolveOutputDir(output: unknown, site: string): string {
  const raw = typeof output === "string" ? output.trim() : ""
  if (!raw) return defaultDownloadDir(site)
  if (raw === "~") return os.homedir()
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2))
  return path.isAbsolute(raw) ? raw : path.join(os.homedir(), raw)
}

export interface MediaItem {
  type: "image" | "video"
  url: string
  /** Optional file name (no directory). */
  filename?: string
}

export interface MediaDownloadOptions {
  output: string
  subdir?: string
  filenamePrefix?: string
  headers?: Record<string, string>
  cookies?: string
  timeoutMs?: number
}

export interface MediaDownloadRow {
  index: number
  type: string
  status: "success" | "failed"
  size: string
  /** Absolute path on success, empty on failure. */
  path: string
  error?: string
}

export async function downloadMedia(
  items: MediaItem[],
  options: MediaDownloadOptions,
): Promise<MediaDownloadRow[]> {
  const outputDir = options.subdir ? path.join(options.output, sanitizeFilename(options.subdir) || "download") : options.output
  await mkdir(outputDir, { recursive: true })
  const prefix = sanitizeFilename(path.basename(options.filenamePrefix ?? "download")) || "download"
  const rows: MediaDownloadRow[] = []
  for (let i = 0; i < items.length; i++) {
    const media = items[i]!
    const isVideo = media.type === "video"
    const ext = isVideo ? "mp4" : "jpg"
    const fallback = `${prefix}_${i + 1}.${ext}`
    const filename = media.filename ? sanitizeFilename(path.basename(media.filename)) || fallback : fallback
    const destPath = path.join(outputDir, filename)
    const result = await httpDownload(media.url, destPath, {
      headers: options.headers,
      cookies: options.cookies,
      timeoutMs: options.timeoutMs ?? (isVideo ? 60_000 : 30_000),
    })
    rows.push({
      index: i + 1,
      type: media.type,
      status: result.success ? "success" : "failed",
      size: result.success ? formatBytes(result.size) : "",
      path: result.success ? destPath : "",
      ...(result.success ? {} : { error: result.error ?? "unknown error" }),
    })
  }
  return rows
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
}

/** File extension for a response content type, or undefined when unknown. */
export function extensionForContentType(contentType: string | undefined): string | undefined {
  return contentType ? EXT_BY_CONTENT_TYPE[contentType] : undefined
}
