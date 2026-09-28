// @vitest-environment node
import { runInNewContext } from "node:vm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { parseXhsLikeCountText, parseXhsProfileHref } from "./comments.ts"
import {
  findNoteInState,
  parseInitialState,
  parseSrt,
  pickSubtitleTrack,
  toXhsNote,
  type XhsSubtitleTrack,
} from "./note-data.ts"
import { BROWSER_EXTRACT_JS, getNote } from "./note.ts"
import { buildNoteUrl, parseNoteId } from "./note-helpers.ts"
import { noteIdToDate } from "./search.ts"
import { extractXhsUserNotes, normalizeXhsUserId } from "./user-helpers.ts"

const NOTE_ID = "64b8f0a1000000001f03a8c2"
const SIGNED = `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=TOKEN&xsec_source=app_share`
const SRC_SRT = "https://sns-subtitle-s2.xhscdn.com/subtitle/a_1.srt?sign=x"
const EN_SRT = "https://sns-subtitle-s2.xhscdn.com/subtitle/a_12.srt?sign=x"

/** The note object as the mobile page embeds it (field names as observed on the live site). */
function sampleNote(): Record<string, unknown> {
  return {
    noteId: NOTE_ID,
    type: "video",
    title: "Title",
    desc: "line one\nline two #tag[话题]#",
    user: { userId: "5d8f88dc0000000001005d3a", nickName: "Alice" },
    interactInfo: { likedCount: "864", collectedCount: "1,515", commentCount: "42", shareCount: "1,158" },
    tagList: [{ id: "1", name: "tag", type: "topic" }],
    time: 1_700_000_000_000,
    ipLocation: null,
    imageList: [{ url: "http://sns-webpic-qc.xhscdn.com/202609281904/abc/spectrum/cover!h5_1080jpg", infoList: [] }],
    video: {
      consumer: { originVideoKey: "pre_post/origin_key" },
      media: {
        stream: {
          h265: [{ masterUrl: "https://sns-video-bd.xhscdn.com/h265.mp4" }],
          h264: [{ masterUrl: "https://sns-video-bd.xhscdn.com/h264.mp4", backupUrls: ["https://sns-bak-v1.xhscdn.com/h264.mp4"] }],
        },
      },
      // A JSON *string* on the live site.
      mediaV2: JSON.stringify({
        video: {
          opaque1: { isSupportSubtitle: "true" },
          subtitles: {
            "en-US": [{ url: EN_SRT, language: "en-US" }],
            source: [{ url: SRC_SRT, language: "zh-CN" }],
            "zh-CN": [{ url: SRC_SRT, language: "zh-CN" }],
          },
        },
      }),
    },
  }
}

/** Mobile page HTML: the state literal carries bare `undefined` values, as the real one does. */
function mobileHtml(note: Record<string, unknown>): string {
  const literal = JSON.stringify({ global: { x: 1 }, noteData: { data: { noteData: note } } }).replace(
    '"global":{"x":1}',
    '"global":{"x":1,"y":undefined,"z":[undefined]}',
  )
  return `<html><script>window.__INITIAL_STATE__=${literal}</script></html>`
}

const SRT = "﻿1\r\n00:00:00,000 --> 00:00:01,470\r\n如果一年只爬一次山\r\n\r\n2\r\n00:00:01,470 --> 00:00:06,700\r\n就选这条路线\r\n第二行\r\n"

describe("page state", () => {
  it("parses the state literal, undefined values included", () => {
    const state = parseInitialState(mobileHtml(sampleNote()))
    expect(state).not.toBeNull()
    expect(findNoteInState(state, NOTE_ID)?.title).toBe("Title")
  })

  it("finds the note in the desktop shape, ignoring preloaded neighbours", () => {
    const other = { noteId: "650000000000000000000000", title: "Other" }
    const state = { note: { noteDetailMap: { [NOTE_ID]: { note: sampleNote() }, [other.noteId]: { note: other } } } }
    expect(findNoteInState(state, NOTE_ID)?.title).toBe("Title")
    expect(findNoteInState({ note: { noteDetailMap: { [other.noteId]: { note: other }, x: {} } } }, NOTE_ID)).toBeNull()
  })

  it("returns null when there is no state or no note", () => {
    expect(parseInitialState("<html>shell</html>")).toBeNull()
    expect(findNoteInState({ global: {} }, NOTE_ID)).toBeNull()
  })
})

describe("toXhsNote", () => {
  it("reads text, counts and tags, keeping line breaks", () => {
    expect(toXhsNote(sampleNote(), { id: NOTE_ID, url: SIGNED })).toMatchObject({
      id: NOTE_ID,
      url: SIGNED,
      title: "Title",
      text: "line one\nline two #tag[话题]#",
      type: "video",
      author: "Alice",
      authorId: "5d8f88dc0000000001005d3a",
      tags: ["tag"],
      likes: "864",
      collects: "1,515",
      comments: "42",
      shares: "1,158",
      publishedAt: new Date(1_700_000_000_000).toISOString(),
      ipLocation: "",
      subtitles: null,
    })
  })

  it("puts the video first (h264, then h265, then the upload key) and upgrades http images", () => {
    const [video, image] = toXhsNote(sampleNote(), { id: NOTE_ID, url: SIGNED }).media
    expect(video).toEqual({
      type: "video",
      url: "https://sns-video-bd.xhscdn.com/h264.mp4",
      fallbacks: [
        "https://sns-bak-v1.xhscdn.com/h264.mp4",
        "https://sns-video-bd.xhscdn.com/h265.mp4",
        "https://sns-video-bd.xhscdn.com/pre_post/origin_key",
      ],
    })
    expect(image?.url).toBe("https://sns-webpic-qc.xhscdn.com/202609281904/abc/spectrum/cover!h5_1080jpg")
  })

  it("lists subtitle tracks, source first, without duplicates", () => {
    expect(toXhsNote(sampleNote(), { id: NOTE_ID, url: SIGNED }).subtitleTracks).toEqual([
      { language: "zh-CN", kind: "source", url: SRC_SRT },
      { language: "en-US", kind: "translation", url: EN_SRT },
    ])
  })

  it("has no tracks for an image note", () => {
    const note = { ...sampleNote(), type: "normal", video: undefined }
    expect(toXhsNote(note, { id: NOTE_ID, url: SIGNED }).subtitleTracks).toEqual([])
  })
})

describe("subtitles", () => {
  const tracks: XhsSubtitleTrack[] = [
    { language: "zh-CN", kind: "source", url: SRC_SRT },
    { language: "en-US", kind: "translation", url: EN_SRT },
  ]

  it("parses SRT with a BOM, CRLF and multi-line cues", () => {
    expect(parseSrt(SRT)).toEqual([
      { start: 0, end: 1.47, text: "如果一年只爬一次山" },
      { start: 1.47, end: 6.7, text: "就选这条路线\n第二行" },
    ])
  })

  it("picks the source track, a language, or nothing", () => {
    expect(pickSubtitleTrack(tracks, "source")?.url).toBe(SRC_SRT)
    expect(pickSubtitleTrack(tracks, "en-US")?.url).toBe(EN_SRT)
    expect(pickSubtitleTrack(tracks, "en")?.url).toBe(EN_SRT)
    expect(pickSubtitleTrack(tracks, "ja-JP")).toBeNull()
    expect(pickSubtitleTrack([], "source")).toBeNull()
  })
})

describe("getNote", () => {
  const fetchMock = vi.fn<typeof fetch>()
  const realFetch = globalThis.fetch

  beforeEach(() => {
    fetchMock.mockReset()
    globalThis.fetch = fetchMock
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** `Response.url` is a getter; the final URL after redirects is what the code reads. */
  const respond = (body: string, status = 200, url = "") => {
    const response = new Response(body, { status })
    if (url) Object.defineProperty(response, "url", { value: url })
    return response
  }

  it("reads directly with a mobile user agent and attaches the source transcript", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === SRC_SRT) return respond(SRT)
      return respond(mobileHtml(sampleNote()), 200, SIGNED)
    })
    const note = (await getNote({ url: SIGNED })) as Record<string, unknown>
    expect(note.source).toBe("direct")
    expect(note.subtitles).toMatchObject({ language: "zh-CN", kind: "source", text: "如果一年只爬一次山\n就选这条路线\n第二行" })
    const [pageUrl, init] = fetchMock.mock.calls[0]!
    expect(String(pageUrl)).toBe(SIGNED)
    expect(new Headers(init?.headers).get("user-agent")).toMatch(/iPhone/)
  })

  it("skips subtitles when asked", async () => {
    fetchMock.mockResolvedValue(respond(mobileHtml(sampleNote()), 200, SIGNED))
    const note = (await getNote({ url: SIGNED, subtitles: "none" })) as Record<string, unknown>
    expect(note.subtitles).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("falls back to the browser when the direct read has no note", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === SRC_SRT ? respond(SRT) : respond("<html>shell</html>", 200, SIGNED))
    const state = { note: { noteDetailMap: { [NOTE_ID]: { note: sampleNote() } } }, noteData: null }
    const evaluate = vi.fn(async () => ({ pageUrl: SIGNED, loginWall: false, notFound: false, securityBlock: false, state, dom: {} }))
    const browser = { tabs: { new: async () => ({ goto: async () => {}, playwright: { evaluate } }) } }
    const note = (await getNote({ url: SIGNED, browser })) as Record<string, unknown>
    expect(note.source).toBe("browser")
    expect(note.title).toBe("Title")
    expect((note.subtitles as { kind: string }).kind).toBe("source")
    expect(note.warnings).toEqual([expect.stringMatching(/used Chrome/)])
  }, 15_000)

  it("does not open a tab when the direct read works", async () => {
    fetchMock.mockResolvedValue(respond(mobileHtml(sampleNote()), 200, SIGNED))
    const newTab = vi.fn()
    await getNote({ url: SIGNED, subtitles: "none", browser: { tabs: { new: newTab } } })
    expect(newTab).not.toHaveBeenCalled()
  })

  it("reports risk control, with the browser as the way out, when there is none", async () => {
    fetchMock.mockResolvedValue(
      respond("", 200, "https://www.xiaohongshu.com/website-login/error?error_code=300017"),
    )
    await expect(getNote({ url: SIGNED })).rejects.toMatchObject({ code: "SECURITY_BLOCK" })
  })

  it("rejects unsigned URLs before any request", async () => {
    await expect(getNote({ url: `https://www.xiaohongshu.com/explore/${NOTE_ID}` })).rejects.toMatchObject({ code: "ARGUMENT" })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("browser fallback script", () => {
  it("runs, and hands the store back as plain data", () => {
    const node = { innerText: "", textContent: "", querySelector: () => null, querySelectorAll: () => [] }
    const ctx = {
      document: { body: node, querySelector: () => null },
      location: { href: SIGNED },
      window: { __INITIAL_STATE__: { note: { noteDetailMap: { [NOTE_ID]: { note: sampleNote() } } } } },
      JSON,
    }
    const out = runInNewContext(BROWSER_EXTRACT_JS, ctx) as Record<string, unknown>
    expect(findNoteInState(out.state, NOTE_ID)?.title).toBe("Title")
    expect(out.securityBlock).toBe(false)
  })
})

describe("helpers", () => {
  it("accepts signed note URLs and short links only where allowed", () => {
    expect(buildNoteUrl(SIGNED)).toBe(SIGNED)
    expect(() => buildNoteUrl(NOTE_ID)).toThrow(/signed note URL/)
    expect(() => buildNoteUrl("https://xhslink.com/a/abc")).toThrow()
    expect(buildNoteUrl("https://xhslink.com/a/abc", { allowShortLink: true })).toBe("https://xhslink.com/a/abc")
    expect(parseNoteId(SIGNED)).toBe(NOTE_ID)
  })

  it("parses like counts with 万/k units", () => {
    expect(parseXhsLikeCountText("1.2万")).toBe(12000)
    expect(parseXhsLikeCountText("3k")).toBe(3000)
    expect(parseXhsLikeCountText("1,234")).toBe(1234)
    expect(parseXhsLikeCountText("赞")).toBe(0)
  })

  it("reads profile ids only from xiaohongshu profile links", () => {
    expect(parseXhsProfileHref("/user/profile/5d8f88dc0000000001005d3a")).toBe("5d8f88dc0000000001005d3a")
    expect(parseXhsProfileHref("https://evil.example/user/profile/abc")).toBe("")
    expect(normalizeXhsUserId("https://www.xiaohongshu.com/user/profile/abc123?xsec_token=1")).toBe("abc123")
  })

  it("decodes the publish date from the note id", () => {
    expect(noteIdToDate("https://www.xiaohongshu.com/search_result/697f6c740000000000000000?xsec_token=x")).toBe("2026-02-01")
  })

  it("maps user store notes to signed URLs, dropping duplicates", () => {
    const card = { noteId: NOTE_ID, displayTitle: "T", type: "video", interactInfo: { likedCount: "9" }, user: { userId: "u1" } }
    const rows = extractXhsUserNotes({ noteGroups: [[{ noteCard: card, xsecToken: "tok" }, { noteCard: card }], []] }, "u1")
    expect(rows).toEqual([{
      id: NOTE_ID, title: "T", type: "video", likes: "9", cover: "",
      url: `https://www.xiaohongshu.com/user/profile/u1/${NOTE_ID}?xsec_token=tok&xsec_source=pc_user`,
    }])
  })
})
