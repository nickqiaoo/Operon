import { defineCommand } from "../define.ts"
import { ArgumentError, CommandExecutionError, EmptyResultError } from "../errors.ts"
import { registerGuide } from "../registry.ts"
import { GUIDE } from "./guide.ts"
import { DESC_MAX_LEN, formatSummaryRow, wikiFetch } from "./utils.ts"

export interface WikipediaSearchRow {
  title: string
  snippet: string
  url: string
}

export interface WikipediaSummaryRow {
  title: unknown
  description: unknown
  extract: string
  url: string
}

export interface WikipediaPageRow {
  title: unknown
  description: unknown
  pageId: unknown | null
  paragraphs: number
  extract: string
  url: unknown
}

export interface WikipediaRandomRow {
  title: unknown
  description: unknown
  extract: string
  url: string
}

export interface WikipediaTrendingRow {
  rank: number
  title: unknown
  description: string
  views: unknown
}

registerGuide("wikipedia", GUIDE)

export const search = defineCommand({
  site: "wikipedia",
  name: "search",
  description: "Search Wikipedia articles",
  domain: "wikipedia.org",
  access: "read",
  browser: false,
  args: [
    { name: "query", required: true, },
    { name: "limit", type: "int", default: 10 },
    { name: "lang", default: "en", help: "Language code (en, zh, ja…)" },
  ],
  func: async (_page, args): Promise<WikipediaSearchRow[]> => {
    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50))
    const lang = String(args.lang || "en")
    const q = encodeURIComponent(String(args.query))
    const data = (await wikiFetch(
      lang,
      `/w/api.php?action=query&list=search&srsearch=${q}&srlimit=${limit}&format=json&utf8=1`,
    )) as { query?: { search?: Array<{ title: string; snippet: string }> } }
    const results = data?.query?.search
    if (!results?.length) throw new EmptyResultError("wikipedia", "wikipedia.search: no articles found")
    return results.map((r) => ({
      title: r.title,
      snippet: r.snippet.replace(/<[^>]+>/g, "").slice(0, 120),
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
    }))
  },
})

export const summary = defineCommand({
  site: "wikipedia",
  name: "summary",
  description: "Get Wikipedia article summary",
  domain: "wikipedia.org",
  access: "read",
  browser: false,
  args: [
    { name: "title", required: true, },
    { name: "lang", default: "en" },
  ],
  func: async (_page, args): Promise<WikipediaSummaryRow> => {
    const lang = String(args.lang || "en")
    const title = encodeURIComponent(String(args.title).replace(/ /g, "_"))
    const data = (await wikiFetch(lang, `/api/rest_v1/page/summary/${title}`)) as Record<string, unknown>
    if (!data?.title) throw new EmptyResultError("wikipedia", `wikipedia.summary: article "${args.title}" not found`)
    return formatSummaryRow(data, lang)
  },
})

export const page = defineCommand({
  site: "wikipedia",
  name: "page",
  description: "Full plain-text extract of a Wikipedia article",
  domain: "wikipedia.org",
  access: "read",
  browser: false,
  args: [
    { name: "title", required: true, },
    { name: "lang", default: "en" },
    { name: "paragraphs", type: "int", default: 0, help: "Cap paragraphs (0 = full)" },
  ],
  func: async (_page, args): Promise<WikipediaPageRow> => {
    const title = String(args.title ?? "").trim()
    if (!title) throw new ArgumentError("wikipedia.page: title required")
    const lang = String(args.lang ?? "en").trim().toLowerCase()
    const paragraphsCap = Number(args.paragraphs ?? 0)
    if (!Number.isInteger(paragraphsCap) || paragraphsCap < 0) {
      throw new ArgumentError("wikipedia.page: paragraphs must be >= 0")
    }
    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`)
    url.searchParams.set("action", "query")
    url.searchParams.set("format", "json")
    url.searchParams.set("formatversion", "2")
    url.searchParams.set("prop", "extracts|info|description")
    url.searchParams.set("inprop", "url")
    url.searchParams.set("explaintext", "1")
    url.searchParams.set("redirects", "1")
    url.searchParams.set("titles", title)
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "operon-site-adapters/1.0",
        Accept: "application/json",
      },
    })
    if (!resp.ok) throw new CommandExecutionError(`wikipedia.page: HTTP ${resp.status}`)
    const data = (await resp.json()) as {
      error?: { info?: string }
      query?: { pages?: Array<Record<string, unknown>> }
    }
    if (data?.error) throw new CommandExecutionError(`wikipedia API: ${data.error.info}`)
    const page0 = data.query?.pages?.[0]
    if (!page0 || page0.missing) {
      throw new EmptyResultError("wikipedia", `wikipedia.page: no article "${title}" on ${lang}.wikipedia.org`)
    }
    const fullExtract = String(page0.extract ?? "")
    if (!fullExtract.trim()) {
      throw new EmptyResultError("wikipedia", `wikipedia.page: "${page0.title}" has no plain-text extract`)
    }
    const allParas = fullExtract.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
    const paras = paragraphsCap > 0 ? allParas.slice(0, paragraphsCap) : allParas
    return {
      title: page0.title,
      description: page0.description || "",
      pageId: page0.pageid ?? null,
      paragraphs: paras.length,
      extract: paras.join("\n\n"),
      url:
        page0.fullurl
        || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(page0.title).replace(/ /g, "_"))}`,
    }
  },
})

export const random = defineCommand({
  site: "wikipedia",
  name: "random",
  description: "Get a random Wikipedia article",
  domain: "wikipedia.org",
  access: "read",
  browser: false,
  args: [{ name: "lang", default: "en" }],
  func: async (_page, args): Promise<WikipediaRandomRow> => {
    const lang = String(args.lang || "en")
    const data = (await wikiFetch(lang, "/api/rest_v1/page/random/summary")) as Record<string, unknown>
    if (!data?.title) throw new EmptyResultError("wikipedia", "wikipedia.random: empty response")
    return formatSummaryRow(data, lang)
  },
})

export const trending = defineCommand({
  site: "wikipedia",
  name: "trending",
  description: "Most-read Wikipedia articles (yesterday UTC)",
  domain: "wikipedia.org",
  access: "read",
  browser: false,
  args: [
    { name: "limit", type: "int", default: 10 },
    { name: "lang", default: "en" },
  ],
  func: async (_page, args): Promise<WikipediaTrendingRow[]> => {
    const lang = String(args.lang || "en")
    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50))
    const d = new Date(Date.now() - 86_400_000)
    const yyyy = d.getUTCFullYear()
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
    const dd = String(d.getUTCDate()).padStart(2, "0")
    const data = (await wikiFetch(
      lang,
      `/api/rest_v1/feed/featured/${yyyy}/${mm}/${dd}`,
    )) as { mostread?: { articles?: Array<Record<string, unknown>> } }
    const articles = data?.mostread?.articles
    if (!articles?.length) throw new EmptyResultError("wikipedia", "wikipedia.trending: no data")
    return articles.slice(0, limit).map((a, i) => ({
      rank: i + 1,
      title: a.title,
      description: String(a.description ?? "").slice(0, DESC_MAX_LEN),
      views: a.views ?? 0,
    }))
  },
})
