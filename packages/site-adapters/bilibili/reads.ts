/**
 * Bilibili read commands (site-complete read surface).
 * Ported from OpenCLI `clis/bilibili/*` COOKIE/func adapters.
 */

import { defineCommand } from "../define.ts"
import {
  apiGet,
  fetchJson,
  getSelfUid,
  payloadData,
  resolveBvid,
  resolveUid,
  stripHtml,
} from "./utils.ts"

export const search = defineCommand({
  site: "bilibili",
  name: "search",
  description: "Search Bilibili videos or users",
  domain: "www.bilibili.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "query", required: true, positional: true, help: "Search keyword" },
    { name: "type", default: "video", help: "video or user", choices: ["video", "user"] },
    { name: "page", type: "int", default: 1, help: "Result page" },
    { name: "limit", type: "int", default: 20, help: "Number of results" },
  ],
  columns: ["rank", "title", "author", "score", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("bilibili: browser required")
    const keyword = String(kwargs.query ?? "")
    const type = kwargs.type === "user" ? "user" : "video"
    const pageNum = Number(kwargs.page) || 1
    const limit = Number(kwargs.limit) || 20
    const searchType = type === "user" ? "bili_user" : "video"
    await page.goto("https://www.bilibili.com")
    const payload = (await apiGet(page, "/x/web-interface/wbi/search/type", {
      params: { search_type: searchType, keyword, page: pageNum },
      signed: true,
    })) as { data?: { result?: Array<Record<string, unknown>> } }
    const results = payload?.data?.result ?? []
    return results.slice(0, limit).map((item, i) => {
      if (searchType === "bili_user") {
        return {
          rank: i + 1,
          title: stripHtml(String(item.uname ?? "")),
          author: String(item.usign ?? "").trim(),
          score: item.fans ?? 0,
          url: item.mid ? `https://space.bilibili.com/${item.mid}` : "",
        }
      }
      return {
        rank: i + 1,
        title: stripHtml(String(item.title ?? "")),
        author: item.author ?? "",
        score: item.play ?? 0,
        url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : "",
      }
    })
  },
})

export const ranking = defineCommand({
  site: "bilibili",
  name: "ranking",
  description: "Get Bilibili video ranking board",
  domain: "www.bilibili.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["rank", "title", "author", "score", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("bilibili: browser required")
    await page.goto("https://www.bilibili.com")
    const payload = (await apiGet(page, "/x/web-interface/ranking/v2", {
      params: { rid: 0, type: "all" },
      signed: false,
    })) as { data?: { list?: Array<Record<string, unknown>> } }
    const results = payload?.data?.list ?? []
    const limit = Number(kwargs.limit) || 20
    return results.slice(0, limit).map((item, i) => {
      const owner = (item.owner ?? {}) as Record<string, unknown>
      const stat = (item.stat ?? {}) as Record<string, unknown>
      return {
        rank: i + 1,
        title: item.title ?? "",
        author: owner.name ?? "",
        score: stat.view ?? 0,
        url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : "",
      }
    })
  },
})

export const video = defineCommand({
  site: "bilibili",
  name: "video",
  description: "Get Bilibili video metadata (title, author, stats)",
  domain: "www.bilibili.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "bvid", required: true, positional: true, help: "BV ID, video URL, or b23.tv short link" },
  ],
  columns: ["bvid", "title", "author", "views", "danmaku", "likes", "coins", "favorites", "duration", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("bilibili: browser required")
    const input = String(kwargs.bvid ?? "").trim()
    const bilibiliUrlMatch = input.match(/bilibili\.com\/(?:video|bangumi\/play)\/(BV[A-Za-z0-9]+)/i)
    const bvid = bilibiliUrlMatch?.[1] ?? (await resolveBvid(input))
    await page.goto(`https://www.bilibili.com/video/${bvid}/`)
    const payload = (await apiGet(page, "/x/web-interface/view", {
      params: { bvid },
    })) as { code?: number; message?: string; data?: Record<string, unknown> }
    if (payload.code != null && payload.code !== 0) {
      throw new Error(`Bilibili view API failed: ${payload.message} (${payload.code})`)
    }
    const d = payload.data ?? {}
    const stat = (d.stat ?? {}) as Record<string, unknown>
    const owner = (d.owner ?? {}) as Record<string, unknown>
    return {
      bvid,
      title: d.title ?? "",
      author: owner.name ?? "",
      views: stat.view ?? 0,
      danmaku: stat.danmaku ?? 0,
      likes: stat.like ?? 0,
      coins: stat.coin ?? 0,
      favorites: stat.favorite ?? 0,
      duration: d.duration ?? 0,
      url: `https://www.bilibili.com/video/${bvid}`,
    }
  },
})

export const me = defineCommand({
  site: "bilibili",
  name: "me",
  description: "My Bilibili profile info",
  domain: "www.bilibili.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [],
  columns: ["name", "uid", "level", "coins", "followers", "following"],
  func: async (page) => {
    if (!page) throw new Error("bilibili: browser required")
    await page.goto("https://www.bilibili.com")
    const uid = await getSelfUid(page)
    const payload = (await apiGet(page, "/x/space/wbi/acc/info", {
      params: { mid: uid },
      signed: true,
    })) as { data?: Record<string, unknown> }
    const data = payload?.data ?? {}
    return {
      name: data.name ?? "",
      uid: data.mid ?? uid,
      level: data.level ?? 0,
      coins: data.coins ?? 0,
      followers: data.follower ?? 0,
      following: data.following ?? 0,
    }
  },
})

export const history = defineCommand({
  site: "bilibili",
  name: "history",
  description: "Your watch history",
  keywords: ["观看历史", "历史记录"],
  domain: "www.bilibili.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [{ name: "limit", type: "int", default: 20, help: "Number of results" }],
  columns: ["rank", "title", "author", "progress", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("bilibili: browser required")
    const limit = Number(kwargs.limit) || 20
    await page.goto("https://www.bilibili.com")
    const payload = await apiGet(page, "/x/web-interface/history/cursor", {
      params: { ps: Math.min(limit, 30), type: "archive" },
    })
    const list = (payloadData(payload)?.list as Array<Record<string, unknown>> | undefined) ?? []
    return list.slice(0, limit).map((item, i) => {
      const progress = Number(item.progress ?? 0)
      const duration = Number(item.duration ?? 0)
      let progressStr: string
      if (progress < 0 || (duration > 0 && progress >= duration)) {
        progressStr = "finished"
      } else {
        const pct = duration > 0 ? Math.round((progress / duration) * 100) : 0
        progressStr = `${formatDuration(progress)}/${formatDuration(duration)} (${pct}%)`
      }
      const hist = (item.history ?? {}) as Record<string, unknown>
      return {
        rank: i + 1,
        title: item.title ?? "",
        author: item.author_name ?? "",
        progress: progressStr,
        url: hist.bvid ? `https://www.bilibili.com/video/${hist.bvid}` : "",
      }
    })
  },
})

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

export const userVideos = defineCommand({
  site: "bilibili",
  name: "user-videos",
  description: "Videos uploaded by a given user",
  domain: "www.bilibili.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "uid", required: true, positional: true, help: "User UID or username" },
    { name: "limit", type: "int", default: 20, help: "Number of results" },
    { name: "order", default: "pubdate", help: "Sort: pubdate, click, stow" },
    { name: "page", type: "int", default: 1, help: "Page number" },
  ],
  columns: ["rank", "title", "plays", "likes", "date", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("bilibili: browser required")
    const limit = Number(kwargs.limit) || 20
    const order = String(kwargs.order ?? "pubdate")
    const pageNum = Number(kwargs.page) || 1
    await page.goto("https://www.bilibili.com")
    const uid = await resolveUid(page, String(kwargs.uid))
    const payload = await apiGet(page, "/x/space/wbi/arc/search", {
      params: {
        mid: uid,
        pn: pageNum,
        ps: Math.min(limit, 50),
        order,
      },
      signed: true,
    })
    const list = payloadData(payload)?.list as Record<string, unknown> | undefined
    const vlist = (list?.vlist as Array<Record<string, unknown>> | undefined) ?? []
    return vlist.slice(0, limit).map((item, i) => ({
      rank: i + 1,
      title: item.title ?? "",
      plays: item.play ?? 0,
      likes: item.like ?? 0,
      date: item.created
        ? new Date(Number(item.created) * 1000).toISOString().slice(0, 10)
        : "",
      url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : "",
    }))
  },
})

export const following = defineCommand({
  site: "bilibili",
  name: "following",
  description: "Who a Bilibili user follows",
  domain: "www.bilibili.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "uid", positional: true, help: "Target user id; defaults to the signed-in user" },
    { name: "page", type: "int", default: 1, help: "Page number" },
    { name: "limit", type: "int", default: 50, help: "Items per page (max 50)" },
  ],
  columns: ["mid", "name", "sign", "following", "fans"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("bilibili: browser required")
    await page.goto("https://www.bilibili.com")
    const uid = kwargs.uid
      ? await resolveUid(page, String(kwargs.uid))
      : await getSelfUid(page)
    const pn = Number(kwargs.page) || 1
    const ps = Math.min(Number(kwargs.limit) || 50, 50)
    const payload = (await fetchJson(
      page,
      `https://api.bilibili.com/x/relation/followings?vmid=${uid}&pn=${pn}&ps=${ps}&order=desc`,
    )) as { code?: number; message?: string; data?: { list?: Array<Record<string, unknown>>; total?: number } }
    if (payload.code !== 0) {
      throw new Error(`Failed to fetch the following list: ${payload.message} (${payload.code})`)
    }
    const list = payload.data?.list || []
    if (list.length === 0) {
      return [
        {
          mid: "-",
          name: `${payload.data?.total ?? 0} following in total; this page is empty`,
          sign: "",
          following: "",
          fans: "",
        },
      ]
    }
    return list.map((u) => {
      const official = (u.official_verify ?? {}) as Record<string, unknown>
      return {
        mid: u.mid,
        name: u.uname,
        sign: String(u.sign || "").slice(0, 40),
        following: u.attribute === 6 ? "mutual" : "following",
        fans: official.desc || "",
      }
    })
  },
})

export const dynamic = defineCommand({
  site: "bilibili",
  name: "dynamic",
  description: "Get Bilibili user dynamic feed (following timeline)",
  domain: "www.bilibili.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [{ name: "limit", type: "int", default: 15 }],
  columns: ["id", "author", "text", "likes", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("bilibili: browser required")
    const limit = Number(kwargs.limit) || 15
    await page.goto("https://www.bilibili.com")
    const payload = (await apiGet(page, "/x/polymer/web-dynamic/v1/feed/all", {
      params: {},
      signed: false,
    })) as { data?: { items?: Array<Record<string, unknown>> } }
    const results = payload?.data?.items ?? []
    return results.slice(0, limit).map((item) => {
      const modules = (item.modules ?? {}) as Record<string, unknown>
      const moduleDynamic = (modules.module_dynamic ?? {}) as Record<string, unknown>
      const moduleAuthor = (modules.module_author ?? {}) as Record<string, unknown>
      const moduleStat = (modules.module_stat ?? {}) as Record<string, unknown>
      const desc = (moduleDynamic.desc ?? {}) as Record<string, unknown>
      const major = (moduleDynamic.major ?? {}) as Record<string, unknown>
      const archive = (major.archive ?? {}) as Record<string, unknown>
      let text = ""
      if (desc.text) text = String(desc.text)
      else if (archive.title) text = String(archive.title)
      const like = (moduleStat.like ?? {}) as Record<string, unknown>
      return {
        id: item.id_str ?? "",
        author: moduleAuthor.name ?? "",
        text,
        likes: like.count ?? 0,
        url: item.id_str ? `https://t.bilibili.com/${item.id_str}` : "",
      }
    })
  },
})

const TYPE_MAP: Record<string, string> = {
  DYNAMIC_TYPE_AV: "video",
  DYNAMIC_TYPE_DRAW: "draw",
  DYNAMIC_TYPE_ARTICLE: "article",
  DYNAMIC_TYPE_FORWARD: "forward",
  DYNAMIC_TYPE_WORD: "text",
  DYNAMIC_TYPE_LIVE_RCMD: "live",
  DYNAMIC_TYPE_PGC: "bangumi",
}

export const feed = defineCommand({
  site: "bilibili",
  name: "feed",
  description: "Feed timeline. Without a uid it shows your following timeline; with one, that user's posts",
  domain: "www.bilibili.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "uid", positional: true, help: "User UID or name; omit to show the following timeline" },
    { name: "limit", type: "int", default: 20, help: "Max results" },
    { name: "type", default: "all", help: "Filter: all, video, article, draw, text" },
    { name: "pages", type: "int", default: 1, help: "Pages to fetch (~20 items each)" },
  ],
  columns: ["rank", "time", "author", "title", "type", "likes", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("bilibili: browser required")
    const maxResults = Number(kwargs.limit) || 20
    const maxPages = Number(kwargs.pages) || 1
    const filterType = kwargs.type === "all" ? "" : String(kwargs.type ?? "")
    await page.goto("https://www.bilibili.com")
    const isUserFeed = !!kwargs.uid
    const uid = isUserFeed ? await resolveUid(page, String(kwargs.uid)) : null
    const rows: Array<Record<string, unknown>> = []
    let offset = ""

    for (let p = 0; p < maxPages; p++) {
      if (rows.length >= maxResults) break
      let payload: unknown
      if (isUserFeed) {
        const params: Record<string, unknown> = { host_mid: uid, timezone_offset: -480 }
        if (offset) params.offset = offset
        payload = await apiGet(page, "/x/polymer/web-dynamic/v1/feed/space", { params })
      } else {
        const params: Record<string, unknown> = {
          timezone_offset: -480,
          type: filterType || "all",
          page: p + 1,
        }
        if (offset) params.offset = offset
        payload = await apiGet(page, "/x/polymer/web-dynamic/v1/feed/all", { params })
      }
      const data = payloadData(payload) ?? {}
      const items = (data.items as Array<Record<string, unknown>> | undefined) ?? []
      if (items.length === 0) break
      for (const item of items) {
        if (rows.length >= maxResults) break
        const parsed = parseFeedItem(item)
        if (filterType && parsed.itemType !== filterType) continue
        rows.push({
          rank: rows.length + 1,
          time: parsed.time,
          author: parsed.author,
          title: parsed.title,
          type: parsed.itemType,
          likes: parsed.likes,
          url: parsed.url,
        })
      }
      offset = String(data.offset ?? items[items.length - 1]?.id_str ?? "")
      if (!offset || !data.has_more) break
    }
    return rows
  },
})

function parseFeedItem(item: Record<string, unknown>) {
  const modules = (item.modules ?? {}) as Record<string, unknown>
  const authorModule = (modules.module_author ?? {}) as Record<string, unknown>
  const dynamicModule = (modules.module_dynamic ?? {}) as Record<string, unknown>
  const major = (dynamicModule.major ?? {}) as Record<string, unknown>
  const stat = (modules.module_stat ?? {}) as Record<string, unknown>
  let title = ""
  let url = item.id_str ? `https://t.bilibili.com/${item.id_str}` : ""
  const itemType = TYPE_MAP[String(item.type ?? "")] ?? String(item.type ?? "")
  const archive = (major.archive ?? {}) as Record<string, unknown>
  if (archive.title) {
    title = String(archive.title)
    if (archive.jump_url) url = `https:${archive.jump_url}`
  }
  const article = (major.article ?? {}) as Record<string, unknown>
  if (!title && article.title) {
    title = String(article.title)
    if (article.jump_url) url = `https:${article.jump_url}`
  }
  const desc = (dynamicModule.desc ?? {}) as Record<string, unknown>
  if (!title && desc.text) title = stripHtml(String(desc.text)).slice(0, 60)
  const draw = (major.draw ?? {}) as { items?: unknown[] }
  if (!title && draw.items) {
    const imgCount = draw.items.length ?? 0
    title = imgCount > 0 ? `[${imgCount} images]` : "[photo post]"
  }
  if (!title && item.type === "DYNAMIC_TYPE_FORWARD") title = "[repost]"
  if (!title) title = `[${itemType || "post"}]`
  const like = (stat.like ?? {}) as Record<string, unknown>
  return {
    title,
    url,
    itemType,
    author: authorModule.name ?? "",
    time: authorModule.pub_time ?? "",
    likes: like.count ?? 0,
  }
}
