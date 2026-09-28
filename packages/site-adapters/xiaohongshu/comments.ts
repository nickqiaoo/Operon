/**
 * `xiaohongshu.getComments`: top-level comments of a note, optionally with
 * nested replies (楼中楼). Page logic from OpenCLI clis/xiaohongshu/comments.js;
 * the comment API needs signed requests, so this reads the rendered DOM.
 */

import { defineCommand } from "../define.ts"
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from "../errors.ts"
import { buildNoteUrl } from "./note-helpers.ts"
import { readXhsDetailPage } from "./risk-control.ts"
import { XHS_WEB_HOST } from "./shared.ts"
import { isRecord, requirePage, toCleanString } from "../runtime/values.ts"

export interface XhsComment {
  author: string
  userId: string
  profileUrl: string
  text: string
  likes: number
  time: string
  isReply: boolean
  /** For replies, the nickname being answered. */
  replyTo: string
  images: string[]
}

/** "1.2万" → 12000, "3k" → 3000, "1,234" → 1234; anything else is 0. */
export function parseXhsLikeCountText(value: unknown): number {
  const integerRe = /^(?:\d+|\d{1,3}(?:[,，]\d{3})+)\+?$/u
  const shortformRe = /^((?:\d+|\d{1,3}(?:[,，]\d{3})+)(?:\.\d+)?)([wWkK万千])\+?$/u
  const raw = String(value ?? "").replace(/\s+/g, "")
  if (!raw) return 0
  if (integerRe.test(raw)) return Number(raw.replace(/[,+，]/g, ""))
  const short = raw.match(shortformRe)
  if (!short) return 0
  const numeric = Number(short[1]!.replace(/[,，]/g, ""))
  if (!Number.isFinite(numeric)) return 0
  const unit = short[2]!.toLowerCase()
  return Math.round(numeric * (unit === "w" || unit === "万" ? 10000 : 1000))
}

export function parseXhsProfileHref(href: unknown): string {
  const raw = typeof href === "string" ? href.trim() : ""
  if (!raw) return ""
  let parsed: URL
  try {
    parsed = new URL(raw, `https://${XHS_WEB_HOST}`)
  } catch {
    return ""
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== XHS_WEB_HOST) return ""
  return parsed.pathname.match(/^\/user\/profile\/([a-zA-Z0-9]+)\/?$/)?.[1] ?? ""
}

const PROFILE_HREF_SELECTOR =
  '.author-wrapper a[href*="/user/profile/"], a.name[href*="/user/profile/"], a.user-name[href*="/user/profile/"], a[href*="/user/profile/"]'

/**
 * Scrolls the comment list until `limit` top-level comments are loaded or
 * growth stalls, optionally clicks the "展开 N 条回复" expanders, then reads
 * the rows. The scroll drives every candidate scroller because which element
 * owns the scrollbar depends on the layout.
 */
function buildCommentsExtractJs(withReplies: boolean, limit: number): string {
  return `
    (async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const withReplies = ${withReplies}
      const targetCount = ${limit}

      const bodyText = document.body?.innerText || ''
      const loginWall = /登录后查看|请登录/.test(bodyText)
      const securityBlock = /安全限制|访问链接异常/.test(bodyText)
        || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href)
      if (loginWall || securityBlock) return { pageUrl: location.href, securityBlock, loginWall, results: [] }

      const scroller = document.querySelector('.note-scroller') || document.querySelector('.container')
      const driveScroll = () => {
        if (scroller) scroller.scrollTo(0, scroller.scrollHeight)
        const comments = document.querySelectorAll('.parent-comment')
        const last = comments[comments.length - 1]
        if (last && typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'end' })
        window.scrollTo(0, document.body.scrollHeight)
      }
      {
        let stall = 0
        for (let i = 0; i < 60; i++) {
          const before = document.querySelectorAll('.parent-comment').length
          if (before >= targetCount) break
          driveScroll()
          await wait(1000 + Math.random() * 1200)
          const after = document.querySelectorAll('.parent-comment').length
          if (after <= before) {
            if (++stall >= 6) break
          } else {
            stall = 0
          }
        }
      }

      const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()
      const parseLikes = ${parseXhsLikeCountText.toString()}
      const HREF_SELECTOR = ${JSON.stringify(PROFILE_HREF_SELECTOR)}
      const authorHref = (el) => {
        const anchor = el?.querySelector(HREF_SELECTOR)
        return anchor ? (anchor.getAttribute('href') || '') : ''
      }
      // Attached photos only: skip avatars, inline emoji and badges.
      const extractImages = (el) => {
        const urls = []
        el?.querySelectorAll('img').forEach(img => {
          if (img.classList.contains('avatar-item')) return
          if (img.closest('.content, .note-text')) return
          if (!img.closest('.comment-pic, .reply-pic, .comment-image, .reply-image, .comment-img, .reply-img, [class*="comment-pic"], [class*="reply-pic"], [class*="comment-image"], [class*="reply-image"]')) return
          const src = img.currentSrc || img.src || img.getAttribute('data-src') || ''
          if (src && !urls.includes(src)) urls.push(src)
        })
        return urls
      }
      const expandReplyThreads = async (root) => {
        const clicked = new Set()
        for (let round = 0; round < 3; round++) {
          const expanders = Array.from(root.querySelectorAll('button, [role="button"], span, div')).filter(el => {
            if (!(el instanceof HTMLElement)) return false
            const text = clean(el)
            if (!text || text.length > 24 || clicked.has(text)) return false
            return /(展开|更多回复|全部回复|查看.*回复|共\\d+条回复)/.test(text)
          })
          if (!expanders.length) break
          for (const el of expanders) {
            clicked.add(clean(el))
            el.click()
            await wait(200 + Math.random() * 300)
          }
        }
      }

      const results = []
      for (const p of document.querySelectorAll('.parent-comment')) {
        const item = p.querySelector('.comment-item')
        if (!item) continue
        const author = clean(item.querySelector('.author-wrapper .name, .user-name'))
        const text = clean(item.querySelector('.content, .note-text'))
        if (!text) continue
        results.push({
          author, authorHref: authorHref(item), text,
          likes: parseLikes(clean(item.querySelector('.count'))),
          time: clean(item.querySelector('.date, .time')),
          isReply: false, replyTo: '', images: extractImages(item),
        })
        if (!withReplies) continue
        await expandReplyThreads(p)
        p.querySelectorAll('.reply-container .comment-item-sub, .sub-comment-list .comment-item').forEach(sub => {
          const content = sub.querySelector('.content, .note-text')
          const subText = clean(content)
          if (!subText) return
          results.push({
            author: clean(sub.querySelector('.name, .user-name')),
            authorHref: authorHref(sub),
            text: subText,
            likes: parseLikes(clean(sub.querySelector('.count'))),
            time: clean(sub.querySelector('.date, .time')),
            isReply: true,
            // Reply-to-reply rows name their target ("回复 <nickname>"); others answer the thread root.
            replyTo: clean(content?.querySelector(':scope > .nickname')) || author,
            images: extractImages(sub),
          })
        })
      }
      return { pageUrl: location.href, securityBlock, loginWall, results }
    })()
  `
}

function toComment(row: unknown): XhsComment | null {
  if (!isRecord(row)) return null
  const text = toCleanString(row.text)
  if (!text) return null
  const userId = parseXhsProfileHref(row.authorHref)
  const likes = Number(row.likes)
  return {
    author: toCleanString(row.author),
    userId,
    profileUrl: userId ? `https://${XHS_WEB_HOST}/user/profile/${userId}` : "",
    text,
    likes: Number.isInteger(likes) && likes >= 0 ? likes : 0,
    time: toCleanString(row.time),
    isReply: row.isReply === true,
    replyTo: toCleanString(row.replyTo),
    images: Array.isArray(row.images) ? row.images.map(toCleanString).filter((u) => /^https?:\/\//.test(u)) : [],
  }
}

export const getComments = defineCommand({
  site: "xiaohongshu",
  name: "getComments",
  description:
    "Comments on a Xiaohongshu note in page order; withReplies also expands nested replies. limit counts top-level comments.",
  keywords: ["小红书", "评论", "楼中楼", "rednote", "xhs"],
  domain: XHS_WEB_HOST,
  access: "read",
  browser: true,
  args: [
    { name: "url", required: true, help: "Note URL with xsec_token" },
    { name: "limit", type: "int", default: 20, help: "Top-level comments to return (1-50)" },
    { name: "withReplies", type: "bool", default: false, help: "Include nested replies under each comment" },
  ],
  func: async (rawPage, kwargs) => {
    const page = requirePage(rawPage, "xiaohongshu.getComments")
    const limit = Math.max(1, Math.min(Math.floor(Number(kwargs.limit) || 20), 50))
    const withReplies = kwargs.withReplies === true
    const data = await readXhsDetailPage(page, {
      url: buildNoteUrl(String(kwargs.url), { commandName: "xiaohongshu.getComments" }),
      extractJs: buildCommentsExtractJs(withReplies, limit),
      securityHelp: "The page may be temporarily restricted. Wait a while before reading more notes.",
      // Scroll-and-wait plus reply expansion: the read-only guard would block
      // the page from rendering the comments it lazy-loads meanwhile.
      privileged: true,
    })
    if (!isRecord(data)) throw new CommandExecutionError("xiaohongshu.getComments: unexpected page payload")
    if (data.loginWall) throw new AuthRequiredError(XHS_WEB_HOST, "Note comments require login")
    const all = (Array.isArray(data.results) ? data.results : [])
      .map(toComment)
      .filter((c): c is XhsComment => c !== null)
    if (all.length === 0) throw new EmptyResultError("xiaohongshu.getComments", "No comments were rendered for this note.")
    // Keep replies attached to the top-level comments that made the cut.
    const out: XhsComment[] = []
    let top = 0
    for (const comment of all) {
      if (!comment.isReply && ++top > limit) break
      out.push(comment)
    }
    return out
  },
})
