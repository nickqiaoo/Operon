/**
 * Turning a Xiaohongshu note's page state into an `XhsNote`, plus subtitles.
 *
 * Two page shapes carry the same note object:
 *  - the mobile page (what `fetchNoteDirect` gets): `noteData.data.noteData`
 *  - the desktop page (what Chrome renders):        `note.noteDetailMap[id].note`
 * Both keep the video's subtitle tracks in `video.mediaV2`, a JSON string whose
 * `video.subtitles` maps "source" (the spoken language) and each translation
 * to signed `.srt` URLs on sns-subtitle-*.xhscdn.com, fetchable without login.
 */

import { isRecord, toCleanString, type Row } from "./shared.ts"

export interface XhsNoteMedia {
  type: "image" | "video"
  url: string
  /** Other URLs for the same video (other codecs / CDNs), best first. */
  fallbacks?: string[]
}

export interface XhsSubtitleTrack {
  language: string
  /** "source" is the spoken-language transcript; "translation" is machine translated. */
  kind: "source" | "translation"
  url: string
}

export interface XhsSubtitleCue {
  /** Seconds. */
  start: number
  end: number
  text: string
}

export interface XhsSubtitles {
  language: string
  kind: "source" | "translation"
  /** Cue texts joined by newlines: the transcript. */
  text: string
  cues: XhsSubtitleCue[]
}

export interface XhsNote {
  id: string
  url: string
  title: string
  /** Body text with line breaks kept. */
  text: string
  /** "video" or "normal" (image post). */
  type: string
  author: string
  authorId: string
  tags: string[]
  likes: string
  collects: string
  comments: string
  shares: string
  publishedAt: string
  ipLocation: string
  /** The selected track's transcript, or null when there is none (or it was not requested). */
  subtitles: XhsSubtitles | null
  /** Every subtitle track the video offers. */
  subtitleTracks: XhsSubtitleTrack[]
  media: XhsNoteMedia[]
}

// ---- page state -------------------------------------------------------------

/** `window.__INITIAL_STATE__ = {...}` from page HTML; `undefined` values become null. */
export function parseInitialState(html: string): Row | null {
  const match = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/)
  if (!match) return null
  const literal = match[1]!.trim().replace(/;$/, "").replace(/([:[,])\s*undefined(?=\s*[,\]}])/g, "$1null")
  try {
    const parsed: unknown = JSON.parse(literal)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function get(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

/** The note object in either page shape. Only `noteId`'s entry is trusted when the map holds several. */
export function findNoteInState(state: unknown, noteId: string): Row | null {
  const mobile = get(state, "noteData", "data", "noteData")
  if (isRecord(mobile) && (mobile.noteId || mobile.title || mobile.desc)) return mobile
  const map = get(state, "note", "noteDetailMap")
  if (!isRecord(map)) return null
  const keys = Object.keys(map)
  const entry = map[noteId] ?? (keys.length === 1 ? map[keys[0]!] : undefined)
  const note = isRecord(entry) && isRecord(entry.note) ? entry.note : entry
  return isRecord(note) && (note.noteId || note.title || note.desc) ? note : null
}

// ---- normalising ------------------------------------------------------------

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** XHS renders placeholder text ("赞", "收藏") where a count is 0. */
function countText(value: unknown): string {
  const text = toCleanString(value)
  return /^\d/.test(text) ? text : "0"
}

function https(url: string): string {
  return url.replace(/^http:\/\//i, "https://")
}

function parseMediaV2(video: Row): Row | null {
  const raw = video.mediaV2
  if (isRecord(raw)) return raw
  if (typeof raw !== "string" || !raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function videoUrls(video: Row): string[] {
  const urls: string[] = []
  const push = (url: unknown) => {
    const clean = https(toCleanString(url))
    if (clean && !urls.includes(clean)) urls.push(clean)
  }
  // h264 plays everywhere, then h265; the original upload key last: best
  // quality, but it often refuses direct fetches.
  const streams = [get(video, "media", "stream"), get(parseMediaV2(video), "stream")]
  for (const codec of ["h264", "h265", "av1"]) {
    for (const stream of streams) {
      for (const item of list(get(stream, codec))) {
        if (!isRecord(item)) continue
        push(item.masterUrl ?? item.master_url)
        for (const backup of list(item.backupUrls ?? item.backup_urls)) push(backup)
      }
    }
  }
  const key = toCleanString(get(video, "consumer", "originVideoKey") ?? video.originVideoKey)
  if (key) push(key.startsWith("http") ? key : `https://sns-video-bd.xhscdn.com/${key}`)
  return urls
}

function imageUrl(item: unknown): string {
  if (!isRecord(item)) return ""
  const infos = list(item.infoList).filter(isRecord)
  const raw =
    item.urlDefault ??
    infos.find((info) => info.imageScene === "WB_DFT")?.url ??
    item.url ??
    item.urlPre ??
    infos[0]?.url
  const url = toCleanString(raw)
  return url ? https(url) : ""
}

export function subtitleTracks(note: Row): XhsSubtitleTrack[] {
  const video = isRecord(note.video) ? note.video : null
  const subtitles = video ? get(parseMediaV2(video), "video", "subtitles") : undefined
  if (!isRecord(subtitles)) return []
  const tracks: XhsSubtitleTrack[] = []
  const seen = new Set<string>()
  // "source" first: it is the transcript of what is actually said.
  const keys = Object.keys(subtitles).sort((a, b) => (a === "source" ? -1 : b === "source" ? 1 : 0))
  for (const key of keys) {
    for (const item of list(subtitles[key])) {
      if (!isRecord(item)) continue
      const url = toCleanString(item.url)
      if (!/^https?:\/\//.test(url) || seen.has(url)) continue
      seen.add(url)
      tracks.push({
        language: toCleanString(item.language) || (key === "source" ? "" : key),
        kind: key === "source" ? "source" : "translation",
        url: https(url),
      })
    }
  }
  return tracks
}

export function toXhsNote(note: Row, fallback: { id: string; url: string }): XhsNote {
  const user = isRecord(note.user) ? note.user : {}
  const interact = isRecord(note.interactInfo) ? note.interactInfo : {}
  const video = isRecord(note.video) ? note.video : null
  const media: XhsNoteMedia[] = []
  const videos = video ? videoUrls(video) : []
  if (videos.length > 0) {
    const [first, ...rest] = videos
    media.push({ type: "video", url: first!, ...(rest.length > 0 ? { fallbacks: rest } : {}) })
  }
  for (const item of list(note.imageList)) {
    const url = imageUrl(item)
    if (url && !media.some((m) => m.url === url)) media.push({ type: "image", url })
  }
  const time = Number(note.time)
  return {
    id: toCleanString(note.noteId) || fallback.id,
    url: fallback.url,
    title: toCleanString(note.title),
    text: typeof note.desc === "string" ? note.desc.trim() : "",
    type: toCleanString(note.type) || (videos.length > 0 ? "video" : "normal"),
    author: toCleanString(user.nickname ?? user.nickName),
    authorId: toCleanString(user.userId),
    tags: list(note.tagList).map((tag) => toCleanString(get(tag, "name"))).filter(Boolean),
    likes: countText(interact.likedCount),
    collects: countText(interact.collectedCount),
    comments: countText(interact.commentCount),
    shares: countText(interact.shareCount),
    publishedAt: Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : "",
    ipLocation: toCleanString(note.ipLocation),
    subtitles: null,
    subtitleTracks: subtitleTracks(note),
    media,
  }
}

// ---- subtitles --------------------------------------------------------------

function srtTime(value: string): number {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/)
  if (!match) return Number.NaN
  const [, h, m, s, ms] = match
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms!.padEnd(3, "0")) / 1000
}

export function parseSrt(srt: string): XhsSubtitleCue[] {
  const cues: XhsSubtitleCue[] = []
  for (const block of srt.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean)
    const timingIndex = lines.findIndex((line) => line.includes("-->"))
    if (timingIndex < 0) continue
    const [from, to] = lines[timingIndex]!.split("-->")
    const start = srtTime(from ?? "")
    const end = srtTime((to ?? "").trim().split(/\s+/)[0] ?? "")
    const text = lines.slice(timingIndex + 1).join("\n")
    if (Number.isFinite(start) && Number.isFinite(end) && text) cues.push({ start, end, text })
  }
  return cues
}

/**
 * "source" picks the spoken-language track; a language code picks that
 * translation (or the source track, if it is in that language).
 */
export function pickSubtitleTrack(tracks: XhsSubtitleTrack[], wanted: string): XhsSubtitleTrack | null {
  if (tracks.length === 0) return null
  if (wanted === "source") return tracks.find((t) => t.kind === "source") ?? tracks[0]!
  const lower = wanted.toLowerCase()
  return (
    tracks.find((t) => t.language.toLowerCase() === lower) ??
    tracks.find((t) => t.language.toLowerCase().startsWith(lower.split("-")[0]!)) ??
    null
  )
}
