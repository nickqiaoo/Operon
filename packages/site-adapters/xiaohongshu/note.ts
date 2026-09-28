/**
 * `xiaohongshu.getNote`: a note's text, stats, media URLs and video subtitles.
 * `xiaohongshu.downloadMedia`: save a note's images / video to disk.
 *
 * getNote reads the note without a browser first: the mobile web page is
 * server-rendered with the whole note in `__INITIAL_STATE__`, no login needed.
 * That is a couple of seconds, needs no Chrome tab and raises no site-access
 * prompt. Only when it yields nothing (blocked, private, login-only) and the
 * caller passed a browser does it open the note in Chrome, where the user's
 * login applies (page logic from OpenCLI clis/xiaohongshu/note.js).
 *
 * Everything runs against one deadline. MCP clients give a tool call about a
 * minute, and the kernel keeps running a script whose caller already gave up,
 * so the calls after it queue behind a result nobody will read.
 */

import { readdir, rename } from "node:fs/promises"
import path from "node:path"

import { defineCommand } from "../define.ts"
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from "../errors.ts"
import {
  extensionForContentType,
  formatBytes,
  httpDownload,
  resolveOutputDir,
  sanitizeFilename,
} from "../runtime/download.ts"
import type { AdapterPage, CommandContext } from "../types.ts"
import {
  findNoteInState,
  parseInitialState,
  parseSrt,
  pickSubtitleTrack,
  toXhsNote,
  type XhsNote,
} from "./note-data.ts"
import { buildNoteUrl, parseNoteId } from "./note-helpers.ts"
import { SecurityBlockError, readXhsDetailPage } from "./risk-control.ts"
import { XHS_WEB_HOST, errorText, type Row } from "./shared.ts"
import { isRecord, toCleanString } from "../runtime/values.ts"

export type { XhsNote, XhsNoteMedia, XhsSubtitles, XhsSubtitleTrack } from "./note-data.ts"

/** Whole-call budget, under the ~60s MCP clients allow a tool call. */
const CALL_BUDGET_MS = 50_000
const DIRECT_TIMEOUT_MS = 15_000
const SUBTITLE_TIMEOUT_MS = 10_000

/** The mobile page is server-rendered with the note; the desktop one is an empty shell without login. */
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

class Clock {
  readonly startedAt = Date.now()
  readonly deadlineAt = this.startedAt + CALL_BUDGET_MS
  readonly timings: Record<string, number> = {}
  #last = this.startedAt

  lap(phase: string): void {
    const now = Date.now()
    this.timings[phase] = now - this.#last
    this.#last = now
  }

  remaining(): number {
    return Math.max(0, this.deadlineAt - Date.now())
  }
}

function isBlockedUrl(url: string): boolean {
  return /website-login\/error|error_code=300017|error_code=300031/.test(url)
}

async function fetchText(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; url: string; text: string }> {
  const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) })
  return { status: response.status, url: response.url || url, text: await response.text() }
}

type DirectResult = { note: Row; finalUrl: string } | { blocked: true } | { failed: string }

async function readNoteDirect(url: string, noteId: string, timeoutMs: number): Promise<DirectResult> {
  try {
    const res = await fetchText(url, timeoutMs, { "User-Agent": MOBILE_UA, Referer: `https://${XHS_WEB_HOST}/` })
    if (isBlockedUrl(res.url)) return { blocked: true }
    if (res.status !== 200) return { failed: `HTTP ${res.status}` }
    const state = parseInitialState(res.text)
    if (!state) return { failed: "no page state in the response" }
    const note = findNoteInState(state, parseNoteId(res.url) || noteId)
    return note ? { note, finalUrl: res.url } : { failed: "the page state holds no note" }
  } catch (error) {
    return { failed: errorText(error) }
  }
}

/**
 * Chrome fallback. Hands the store's note object back as-is (JSON-cloned) so the
 * host-side parser treats both routes alike, plus DOM text for pages whose
 * store did not hydrate.
 */
export const BROWSER_EXTRACT_JS = `
  (() => {
    const bodyText = document.body?.innerText || '';
    const out = {
      pageUrl: location.href,
      loginWall: /登录后查看|请登录/.test(bodyText),
      notFound: /页面不见了|笔记不存在|无法浏览/.test(bodyText),
      securityBlock: /安全限制|访问链接异常/.test(bodyText)
        || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href),
      state: null,
      dom: null,
    };
    try {
      const s = window.__INITIAL_STATE__ || {};
      out.state = JSON.parse(JSON.stringify({ note: s.note ? { noteDetailMap: s.note.noteDetailMap } : null, noteData: s.noteData || null }));
    } catch {}
    const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const scope = document.querySelector('#noteContainer') || document;
    out.dom = {
      title: clean(scope.querySelector('#detail-title, .title')),
      desc: clean(scope.querySelector('#detail-desc, .desc, .note-text')),
      author: clean(scope.querySelector('.username, .author-wrapper .name')),
    };
    return out;
  })()
`

async function readNoteInBrowser(page: AdapterPage, url: string, noteId: string, clock: Clock): Promise<XhsNote> {
  const data = await readXhsDetailPage(page, {
    url,
    extractJs: BROWSER_EXTRACT_JS,
    securityHelp: "The page may be temporarily restricted. Wait a while before reading more notes.",
    deadlineAt: clock.deadlineAt,
  })
  if (!isRecord(data)) throw new CommandExecutionError("xiaohongshu.getNote: unexpected page payload")
  if (data.loginWall) throw new AuthRequiredError(XHS_WEB_HOST, "This note requires login")
  const pageUrl = toCleanString(data.pageUrl) || url
  const note = findNoteInState(data.state, parseNoteId(pageUrl) || noteId)
  if (note) return toXhsNote(note, { id: noteId, url: pageUrl })
  const dom = isRecord(data.dom) ? data.dom : {}
  if (data.notFound || (!dom.title && !dom.desc)) {
    throw new EmptyResultError("xiaohongshu.getNote", `Note ${noteId} is unavailable; it may have been deleted or restricted.`)
  }
  // Store missing: text only, no media or subtitles.
  return {
    ...toXhsNote({}, { id: noteId, url: pageUrl }),
    title: toCleanString(dom.title),
    text: toCleanString(dom.desc),
    author: toCleanString(dom.author),
  }
}

async function attachSubtitles(note: XhsNote, wanted: string, clock: Clock, warnings: string[]): Promise<void> {
  const track = pickSubtitleTrack(note.subtitleTracks, wanted)
  if (!track) {
    warnings.push(
      `No "${wanted}" subtitle track; available: ${note.subtitleTracks.map((t) => t.language || t.kind).join(", ")}`,
    )
    return
  }
  try {
    const res = await fetchText(track.url, Math.min(SUBTITLE_TIMEOUT_MS, clock.remaining()))
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    const cues = parseSrt(res.text)
    note.subtitles = { language: track.language, kind: track.kind, text: cues.map((c) => c.text).join("\n"), cues }
  } catch (error) {
    warnings.push(`Subtitle download failed: ${errorText(error)}`)
  }
}

export const getNote = defineCommand({
  site: "xiaohongshu",
  name: "getNote",
  description:
    "Read one Xiaohongshu note: title, body text, author, tags, counts, video subtitles (transcript), and image/video URLs. Works without Chrome; pass browser to fall back to the logged-in session.",
  keywords: ["小红书", "笔记", "正文", "字幕", "视频", "文案", "rednote", "xhs"],
  domain: XHS_WEB_HOST,
  access: "read",
  strategy: "public",
  browser: false,
  args: [
    { name: "url", required: true, help: "Note URL with xsec_token (as shared, or from search/userNotes/feed), or an xhslink.com short link" },
    {
      name: "subtitles",
      default: "source",
      help: 'Subtitle track to fetch: "source" (spoken language), a language like "zh-CN" / "en-US", or "none"',
    },
  ],
  func: async (_page, kwargs, ctx: CommandContext) => {
    const clock = new Clock()
    const warnings: string[] = []
    const input = String(kwargs.url)
    const url = buildNoteUrl(input, { allowShortLink: true, commandName: "xiaohongshu.getNote" })
    const noteId = parseNoteId(input)

    let note: XhsNote
    let source: "direct" | "browser" = "direct"
    const direct = await readNoteDirect(url, noteId, Math.min(DIRECT_TIMEOUT_MS, clock.remaining()))
    clock.lap("direct")
    if ("note" in direct) {
      note = toXhsNote(direct.note, { id: noteId, url: direct.finalUrl })
    } else if (ctx.hasBrowser) {
      warnings.push(`Direct read failed (${"blocked" in direct ? "risk control" : direct.failed}); used Chrome.`)
      source = "browser"
      note = await readNoteInBrowser(await ctx.openPage(), url, noteId, clock)
      clock.lap("browser")
    } else if ("blocked" in direct) {
      throw new SecurityBlockError(
        "Xiaohongshu blocked the direct read (risk control).",
        "Wait a while, or retry with browser: globalThis.chrome to read through your logged-in session.",
      )
    } else {
      throw new CommandExecutionError(
        `xiaohongshu.getNote: could not read the note directly (${direct.failed})`,
        "It may be private or login-only: retry with browser: globalThis.chrome.",
      )
    }

    const wanted = toCleanString(kwargs.subtitles) || "source"
    if (wanted !== "none" && note.subtitleTracks.length > 0) {
      await attachSubtitles(note, wanted, clock, warnings)
      clock.lap("subtitles")
    }
    return { ...note, source, timings: clock.timings, ...(warnings.length > 0 ? { warnings } : {}) }
  },
})

// ---- downloadMedia ----------------------------------------------------------

export interface XhsDownloadedFile {
  index: number
  type: "image" | "video"
  url: string
  path?: string
  size?: string
  error?: string
}

const OUT_OF_TIME = "not downloaded yet: out of time; call downloadMedia again to continue"

/** `<id>_<n>.*` already on disk, from an earlier call that ran out of time. */
async function existingFile(dir: string, base: string): Promise<string | undefined> {
  const names = await readdir(dir).catch(() => [] as string[])
  const found = names.find((name) => name.startsWith(`${base}.`) && !name.endsWith(".download") && !name.endsWith(".tmp"))
  return found ? path.join(dir, found) : undefined
}

export const downloadMedia = defineCommand({
  site: "xiaohongshu",
  name: "downloadMedia",
  description:
    "Save a note's images and video to disk. Pass the object getNote returned. Stops before the MCP time limit; call again to continue, finished files are skipped.",
  keywords: ["小红书", "下载", "视频", "图片", "rednote", "xhs"],
  domain: XHS_WEB_HOST,
  access: "read",
  strategy: "public",
  browser: false,
  args: [
    { name: "note", required: true, help: "The object getNote returned (needs id and media)" },
    { name: "types", default: "all", choices: ["all", "video", "image"], help: "Which media to save" },
    { name: "outputDir", help: "Default ~/Downloads/operon/xiaohongshu; a <noteId> subfolder is created" },
  ],
  func: async (_page, kwargs) => {
    const clock = new Clock()
    const note = kwargs.note
    if (!isRecord(note) || !Array.isArray(note.media)) {
      throw new CommandExecutionError("xiaohongshu.downloadMedia: pass the object getNote returned as `note`")
    }
    const id = sanitizeFilename(toCleanString(note.id)) || "note"
    const dir = path.join(resolveOutputDir(kwargs.outputDir, "xiaohongshu"), id)
    const types = String(kwargs.types ?? "all")
    const headers = { Referer: `https://${XHS_WEB_HOST}/`, "User-Agent": MOBILE_UA }
    const files: XhsDownloadedFile[] = []
    let outOfTime = false

    for (let i = 0; i < note.media.length; i++) {
      const item = note.media[i]
      if (!isRecord(item) || (item.type !== "image" && item.type !== "video")) continue
      if (types !== "all" && item.type !== types) continue
      const file: XhsDownloadedFile = { index: i + 1, type: item.type, url: toCleanString(item.url) }
      files.push(file)
      if (outOfTime) {
        file.error = OUT_OF_TIME
        continue
      }
      const base = `${id}_${i + 1}`
      const existing = await existingFile(dir, base)
      if (existing) {
        file.path = existing
        continue
      }
      const fallbacks = Array.isArray(item.fallbacks) ? item.fallbacks.map(toCleanString) : []
      for (const url of [file.url, ...fallbacks].filter(Boolean)) {
        const remaining = clock.remaining()
        if (remaining < 3000) {
          outOfTime = true
          break
        }
        const tempPath = path.join(dir, `${base}.download`)
        const result = await httpDownload(url, tempPath, { headers, timeoutMs: remaining })
        if (!result.success) {
          file.error = result.error ?? "unknown error"
          continue
        }
        const ext = extensionForContentType(result.contentType) ?? (item.type === "video" ? "mp4" : "jpg")
        const finalPath = path.join(dir, `${base}.${ext}`)
        await rename(tempPath, finalPath)
        Object.assign(file, { url, path: finalPath, size: formatBytes(result.size) })
        delete file.error
        break
      }
      if (outOfTime && !file.path) file.error = OUT_OF_TIME
    }
    if (files.length === 0) throw new EmptyResultError("xiaohongshu.downloadMedia", "No matching media on this note.")
    return { outputDir: dir, complete: files.every((f) => f.path), files }
  },
})
