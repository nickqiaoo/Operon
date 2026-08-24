/**
 * Zhihu read surface — OpenCLI clis/zhihu/* (cookie + api/v4).
 */

import { defineCommand } from "../define.ts"
import {
  assertOk,
  fetchZhihuList,
  parseZhihuUser,
  stripHtml,
  validateLimit,
  zhihuFetchJson,
} from "./utils.ts"

// hot stays in hot.ts (pipeline)

export const user = defineCommand({
  site: "zhihu",
  name: "user",
  description: "Zhihu user profile",
  domain: "www.zhihu.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "user", type: "string", required: true, positional: true, help: "url_token or people URL" },
  ],
  columns: ["url_token", "name", "headline", "followers", "following", "answers", "articles", "voteup", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("zhihu: browser required")
    const slug = parseZhihuUser(kwargs.user)
    await page.goto("https://www.zhihu.com")
    const include =
      "follower_count,following_count,answer_count,articles_count,question_count,voteup_count,thanked_count,favorited_count,headline,gender"
    const apiUrl = `https://www.zhihu.com/api/v4/members/${encodeURIComponent(slug)}?include=${encodeURIComponent(include)}`
    const data = assertOk(await zhihuFetchJson(page, apiUrl), "user")
    return {
      url_token: String(data.url_token || ""),
      name: String(data.name || ""),
      headline: String(data.headline || ""),
      followers: data.follower_count ?? 0,
      following: data.following_count ?? 0,
      answers: data.answer_count ?? 0,
      articles: data.articles_count ?? 0,
      voteup: data.voteup_count ?? 0,
      url: data.url_token ? `https://www.zhihu.com/people/${data.url_token}` : "",
    }
  },
})

export const question = defineCommand({
  site: "zhihu",
  name: "question",
  description: "Zhihu question with answers",
  domain: "www.zhihu.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "id", required: true, positional: true, help: "Question ID (numeric)" },
    { name: "limit", type: "int", default: 5, help: "Number of answers" },
    { name: "sort", default: "default", choices: ["default", "created"], help: "Answer order" },
  ],
  columns: ["rank", "id", "author", "votes", "url", "content"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("zhihu: browser required")
    const questionId = String(kwargs.id)
    if (!/^\d+$/.test(questionId)) throw new Error("zhihu.question: id must be numeric")
    const answerLimit = validateLimit(kwargs.limit, 5, 100)
    const sort = kwargs.sort === "created" ? "created" : "default"
    await page.goto(
      sort === "created"
        ? `https://www.zhihu.com/question/${questionId}/answers/updated`
        : `https://www.zhihu.com/question/${questionId}`,
    )
    const first = `https://www.zhihu.com/api/v4/questions/${questionId}/answers?limit=20&offset=0&sort_by=${sort}&include=data[*].content,url,voteup_count,comment_count,author`
    const items = await fetchZhihuList(page, first, answerLimit, "question answers")
    return items.map((item, i) => {
      const author = (item.author ?? {}) as Record<string, unknown>
      const id = item.id == null ? "" : String(item.id)
      return {
        rank: i + 1,
        id,
        author: author.name ?? "",
        votes: item.voteup_count ?? 0,
        url: id ? `https://www.zhihu.com/question/${questionId}/answer/${id}` : "",
        content: stripHtml(item.content).slice(0, 500),
      }
    })
  },
})

export const search = defineCommand({
  site: "zhihu",
  name: "search",
  description: "Zhihu search",
  keywords: ["搜索", "知乎"],
  domain: "www.zhihu.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "query", required: true, positional: true, help: "Search keyword" },
    { name: "limit", type: "int", default: 10 },
    { name: "type", default: "all", choices: ["all", "answer", "article", "question"] },
  ],
  columns: ["rank", "type", "title", "author", "url", "excerpt"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("zhihu: browser required")
    const query = String(kwargs.query ?? "").trim()
    if (!query) throw new Error("zhihu.search: query required")
    const limit = validateLimit(kwargs.limit, 10, 100)
    const type = String(kwargs.type ?? "all")
    await page.goto("https://www.zhihu.com")
    const t = type === "all" ? "general" : type
    const first = `https://www.zhihu.com/api/v4/search_v3?t=${encodeURIComponent(t)}&q=${encodeURIComponent(query)}&correction=1&offset=0&limit=20&filter_fields=&lc_idx=0&show_all_topics=0`
    const items = await fetchZhihuList(page, first, limit, "search")
    return items.map((item, i) => {
      const obj = (item.object ?? item) as Record<string, unknown>
      const author = (obj.author ?? {}) as Record<string, unknown>
      const id = obj.id == null ? "" : String(obj.id)
      let url = ""
      const otype = String(obj.type || item.type || "")
      if (otype === "answer") {
        const q = (obj.question ?? {}) as Record<string, unknown>
        const qid = q.id == null ? "" : String(q.id)
        url = qid && id ? `https://www.zhihu.com/question/${qid}/answer/${id}` : ""
      } else if (otype === "article") {
        url = id ? `https://zhuanlan.zhihu.com/p/${id}` : ""
      } else if (otype === "question") {
        url = id ? `https://www.zhihu.com/question/${id}` : ""
      }
      const title =
        (obj.title as string)
        || (obj.question as { title?: string } | undefined)?.title
        || stripHtml(obj.excerpt || obj.content).slice(0, 80)
      return {
        rank: i + 1,
        type: otype,
        title: title || "",
        author: author.name ?? "",
        url,
        excerpt: stripHtml(obj.excerpt || obj.content).slice(0, 200),
      }
    })
  },
})

export const recommend = defineCommand({
  site: "zhihu",
  name: "recommend",
  description: "Zhihu home feed",
  domain: "www.zhihu.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [{ name: "limit", type: "int", default: 15 }],
  columns: ["rank", "type", "title", "author", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("zhihu: browser required")
    const limit = validateLimit(kwargs.limit, 15, 50)
    await page.goto("https://www.zhihu.com")
    const first =
      "https://www.zhihu.com/api/v3/feed/topstory/recommend?desktop=true&limit=10&action=down&after_id=0"
    // recommend paging is offset-ish; pull a few pages via list helper when possible
    const data = assertOk(await zhihuFetchJson(page, first), "recommend")
    const batch = Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : []
    return batch.slice(0, limit).map((item, i) => {
      const target = (item.target ?? item) as Record<string, unknown>
      const author = (target.author ?? {}) as Record<string, unknown>
      const id = target.id == null ? "" : String(target.id)
      const type = String(target.type || item.type || "")
      let url = ""
      if (type === "answer") {
        const q = (target.question ?? {}) as Record<string, unknown>
        const qid = q.id == null ? "" : String(q.id)
        url = qid && id ? `https://www.zhihu.com/question/${qid}/answer/${id}` : ""
      } else if (type === "article") {
        url = id ? `https://zhuanlan.zhihu.com/p/${id}` : ""
      } else if (type === "question") {
        url = id ? `https://www.zhihu.com/question/${id}` : ""
      }
      return {
        rank: i + 1,
        type,
        title:
          (target.title as string)
          || (target.question as { title?: string } | undefined)?.title
          || stripHtml(target.excerpt).slice(0, 80),
        author: author.name ?? "",
        url,
      }
    })
  },
})

export const following = defineCommand({
  site: "zhihu",
  name: "following",
  description: "Who a Zhihu user follows",
  domain: "www.zhihu.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "user", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["rank", "name", "headline", "followers", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("zhihu: browser required")
    const slug = parseZhihuUser(kwargs.user)
    const limit = validateLimit(kwargs.limit)
    await page.goto("https://www.zhihu.com")
    const first = `https://www.zhihu.com/api/v4/members/${encodeURIComponent(slug)}/followees?limit=20&offset=0`
    const items = await fetchZhihuList(page, first, limit, "following")
    return items.map((u, i) => ({
      rank: i + 1,
      name: u.name ?? "",
      headline: u.headline ?? "",
      followers: u.follower_count ?? 0,
      url: u.url_token ? `https://www.zhihu.com/people/${u.url_token}` : "",
    }))
  },
})

export const followers = defineCommand({
  site: "zhihu",
  name: "followers",
  description: "A Zhihu user's followers",
  domain: "www.zhihu.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "user", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["rank", "name", "headline", "followers", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("zhihu: browser required")
    const slug = parseZhihuUser(kwargs.user)
    const limit = validateLimit(kwargs.limit)
    await page.goto("https://www.zhihu.com")
    const first = `https://www.zhihu.com/api/v4/members/${encodeURIComponent(slug)}/followers?limit=20&offset=0`
    const items = await fetchZhihuList(page, first, limit, "followers")
    return items.map((u, i) => ({
      rank: i + 1,
      name: u.name ?? "",
      headline: u.headline ?? "",
      followers: u.follower_count ?? 0,
      url: u.url_token ? `https://www.zhihu.com/people/${u.url_token}` : "",
    }))
  },
})

export const userAnswers = defineCommand({
  site: "zhihu",
  name: "user-answers",
  description: "Answers written by a Zhihu user",
  domain: "www.zhihu.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "user", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["rank", "question", "votes", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("zhihu: browser required")
    const slug = parseZhihuUser(kwargs.user)
    const limit = validateLimit(kwargs.limit)
    await page.goto("https://www.zhihu.com")
    const first = `https://www.zhihu.com/api/v4/members/${encodeURIComponent(slug)}/answers?limit=20&offset=0&sort_by=created`
    const items = await fetchZhihuList(page, first, limit, "user-answers")
    return items.map((a, i) => {
      const q = (a.question ?? {}) as Record<string, unknown>
      const id = a.id == null ? "" : String(a.id)
      const qid = q.id == null ? "" : String(q.id)
      return {
        rank: i + 1,
        question: q.title ?? "",
        votes: a.voteup_count ?? 0,
        url: qid && id ? `https://www.zhihu.com/question/${qid}/answer/${id}` : "",
      }
    })
  },
})

export const userArticles = defineCommand({
  site: "zhihu",
  name: "user-articles",
  description: "Articles and columns by a Zhihu user",
  domain: "www.zhihu.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "user", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["rank", "title", "votes", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("zhihu: browser required")
    const slug = parseZhihuUser(kwargs.user)
    const limit = validateLimit(kwargs.limit)
    await page.goto("https://www.zhihu.com")
    const first = `https://www.zhihu.com/api/v4/members/${encodeURIComponent(slug)}/articles?limit=20&offset=0`
    const items = await fetchZhihuList(page, first, limit, "user-articles")
    return items.map((a, i) => {
      const id = a.id == null ? "" : String(a.id)
      return {
        rank: i + 1,
        title: a.title ?? "",
        votes: a.voteup_count ?? 0,
        url: id ? `https://zhuanlan.zhihu.com/p/${id}` : "",
      }
    })
  },
})

export const pins = defineCommand({
  site: "zhihu",
  name: "pins",
  description: "Pins posted by a Zhihu user",
  domain: "www.zhihu.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "user", required: true, positional: true },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["rank", "excerpt", "likes", "comments", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("zhihu: browser required")
    const slug = parseZhihuUser(kwargs.user)
    const limit = validateLimit(kwargs.limit)
    await page.goto("https://www.zhihu.com")
    const first = `https://www.zhihu.com/api/v4/members/${encodeURIComponent(slug)}/pins?limit=20&offset=0`
    const items = await fetchZhihuList(page, first, limit, "pins")
    return items.map((p, i) => ({
      rank: i + 1,
      excerpt: String(p.excerpt_title || p.excerpt || "").slice(0, 120),
      likes: p.like_count ?? p.reaction_count ?? 0,
      comments: p.comment_count ?? 0,
      url: p.id ? `https://www.zhihu.com/pin/${p.id}` : "",
    }))
  },
})

export const collections = defineCommand({
  site: "zhihu",
  name: "collections",
  description: "Zhihu collections, for the signed-in user or a named one",
  domain: "www.zhihu.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "user", positional: true, help: "url_token; omit to try the signed-in user" },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["rank", "title", "items", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("zhihu: browser required")
    const limit = validateLimit(kwargs.limit)
    await page.goto("https://www.zhihu.com")
    let slug = kwargs.user ? parseZhihuUser(kwargs.user) : ""
    if (!slug) {
      // discover self via people link if possible
      const me = assertOk(
        await zhihuFetchJson(page, "https://www.zhihu.com/api/v4/me"),
        "me",
      )
      slug = String(me.url_token || "")
      if (!slug) throw new Error("zhihu.collections: provide user or login")
    }
    const first = `https://www.zhihu.com/api/v4/members/${encodeURIComponent(slug)}/collections?limit=20&offset=0`
    const items = await fetchZhihuList(page, first, limit, "collections")
    return items.map((c, i) => ({
      rank: i + 1,
      title: c.title ?? "",
      items: c.item_count ?? c.answer_count ?? 0,
      url: c.id ? `https://www.zhihu.com/collection/${c.id}` : "",
    }))
  },
})

export const answerDetail = defineCommand({
  site: "zhihu",
  name: "answer-detail",
  description: "Full text of a single Zhihu answer",
  domain: "www.zhihu.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "id", required: true, positional: true, help: "Answer ID or full answer URL" },
    { name: "maxContent", type: "int", default: 0, help: "Cap content length (0 = full, max 5000 stored as slice for safety if set)" },
  ],
  columns: ["id", "author", "votes", "comments", "question_id", "question_title", "url", "content"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("zhihu: browser required")
    const raw = String(kwargs.id ?? "").trim()
    let answerId = ""
    let questionId = ""
    if (/^\d+$/.test(raw)) answerId = raw
    else {
      try {
        const url = new URL(raw)
        const m = url.pathname.match(/^\/question\/(\d+)\/answer\/(\d+)\/?$/)
        if (m) {
          questionId = m[1]!
          answerId = m[2]!
        } else {
          const bare = url.pathname.match(/^\/answer\/(\d+)\/?$/)
          if (bare) answerId = bare[1]!
        }
      } catch {
        // ignore
      }
    }
    if (!answerId) throw new Error("zhihu.answer-detail: invalid answer id/url")
    await page.goto("https://www.zhihu.com")
    const apiUrl = `https://www.zhihu.com/api/v4/answers/${answerId}?include=content,voteup_count,comment_count,author,question`
    const data = assertOk(await zhihuFetchJson(page, apiUrl), "answer-detail")
    const author = (data.author ?? {}) as Record<string, unknown>
    const question = (data.question ?? {}) as Record<string, unknown>
    const qid = questionId || (question.id == null ? "" : String(question.id))
    const maxContent = Number(kwargs.maxContent) || 0
    let content = stripHtml(data.content, { preserveBlocks: true })
    if (maxContent > 0) content = content.slice(0, maxContent)
    return {
      id: answerId,
      author: author.name ?? "",
      votes: data.voteup_count ?? 0,
      comments: data.comment_count ?? 0,
      question_id: qid,
      question_title: question.title ?? "",
      url: qid ? `https://www.zhihu.com/question/${qid}/answer/${answerId}` : `https://www.zhihu.com/answer/${answerId}`,
      content,
    }
  },
})

export const answerComments = defineCommand({
  site: "zhihu",
  name: "answer-comments",
  description: "Comments on a Zhihu answer",
  domain: "www.zhihu.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "id", required: true, positional: true, help: "Answer ID or URL" },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["rank", "author", "content", "likes", "created"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("zhihu: browser required")
    const raw = String(kwargs.id ?? "").trim()
    let answerId = ""
    if (/^\d+$/.test(raw)) answerId = raw
    else {
      try {
        const url = new URL(raw)
        const m = url.pathname.match(/\/answer\/(\d+)/)
        if (m) answerId = m[1]!
      } catch {
        // ignore
      }
    }
    if (!answerId) throw new Error("zhihu.answer-comments: invalid answer id/url")
    const limit = validateLimit(kwargs.limit)
    await page.goto("https://www.zhihu.com")
    const first = `https://www.zhihu.com/api/v4/answers/${answerId}/root_comments?order=normal&limit=20&offset=0&status=open`
    const items = await fetchZhihuList(page, first, limit, "answer-comments")
    return items.map((c, i) => {
      const author = (c.author ?? {}) as Record<string, unknown>
      const member = (author.member ?? author) as Record<string, unknown>
      return {
        rank: i + 1,
        author: member.name ?? "",
        content: stripHtml(c.content).slice(0, 300),
        likes: c.vote_count ?? c.like_count ?? 0,
        created: c.created_time
          ? new Date(Number(c.created_time) * 1000).toISOString()
          : "",
      }
    })
  },
})
