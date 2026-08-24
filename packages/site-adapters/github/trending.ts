/**
 * GitHub Trending repositories — OpenCLI `github-trending/repos.js` (public HTML).
 */

import { defineCommand } from "../define.ts"

const SINCE: Record<string, string> = {
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
}

function decodeHtmlEntities(value: unknown): string {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
}

function stripTags(value: unknown): string {
  return String(value ?? "").replace(/<[^>]*>/g, "")
}

function parseCount(value: unknown): number | null {
  if (value == null) return null
  const digits = String(value).replace(/[,\s]/g, "")
  if (!/^\d+$/.test(digits)) return null
  return Number(digits)
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function assertCount(value: unknown, field: string, repo: string): number {
  const count = parseCount(value)
  if (count == null) throw new Error(`github.trending: missing ${field} for ${repo}`)
  return count
}

function parseTrendingHtml(html: string, limit: number) {
  const blocks = Array.from(
    String(html ?? "").matchAll(/<article\b[^>]*class="[^"]*\bBox-row\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g),
  ).map((m) => m[1]!)
  const rows: Array<Record<string, unknown>> = []
  if (blocks.length === 0) {
    if (/don.t have any trending repositories/i.test(stripTags(html))
      || /no trending repositories/i.test(stripTags(html))) {
      return rows
    }
    throw new Error("github.trending: no repository rows found (parser drift?)")
  }
  for (const block of blocks) {
    const nameMatch = block.match(/<h2\b[\s\S]*?href="\/([^"/?#]+\/[^"/?#]+)"/)
    if (!nameMatch) throw new Error("github.trending: missing repository link")
    const repo = decodeHtmlEntities(nameMatch[1]).trim()
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error(`github.trending: invalid repo "${repo}"`)
    }
    const descMatch = block.match(/<p class="col-9 color-fg-muted[^"]*">([\s\S]*?)<\/p>/)
    const description = descMatch
      ? decodeHtmlEntities(stripTags(descMatch[1]).replace(/\s+/g, " ")).trim()
      : ""
    const langMatch = block.match(/<span itemprop="programmingLanguage">([\s\S]*?)<\/span>/)
    const language = langMatch ? decodeHtmlEntities(stripTags(langMatch[1])).trim() : null
    const escapedRepo = escapeRegExp(repo)
    const starsMatch = block.match(
      new RegExp(`<a\\b[^>]*href="/${escapedRepo}/stargazers"[^>]*>([\\s\\S]*?)</a>`),
    )
    const forksMatch = block.match(
      new RegExp(`<a\\b[^>]*href="/${escapedRepo}/forks"[^>]*>([\\s\\S]*?)</a>`),
    )
    const sinceMatch = block.match(/([\d,]+)\s+stars\s+(?:today|this week|this month)/i)
    rows.push({
      repo,
      description,
      language,
      stars: assertCount(starsMatch ? stripTags(starsMatch[1]) : null, "stars", repo),
      forks: assertCount(forksMatch ? stripTags(forksMatch[1]) : null, "forks", repo),
      starsSince: assertCount(sinceMatch?.[1], "period stars", repo),
      url: `https://github.com/${repo}`,
    })
    if (rows.length >= limit) break
  }
  return rows
}

export const trending = defineCommand({
  site: "github",
  name: "trending",
  description: "GitHub Trending repositories (public, no login)",
  domain: "github.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [
    { name: "since", default: "daily", help: "daily / weekly / monthly", choices: ["daily", "weekly", "monthly"] },
    { name: "language", default: "", help: 'Language slug e.g. python, rust, "c++"' },
    { name: "limit", type: "int", default: 25, help: "Max 25" },
  ],
  columns: ["rank", "repo", "description", "language", "stars", "forks", "starsSince", "url"],
  func: async (_page, args) => {
    const sinceKey = String(args.since ?? "daily").toLowerCase()
    const since = SINCE[sinceKey]
    if (!since) throw new Error(`github.trending: unknown since "${sinceKey}"`)
    const n = Number(args.limit ?? 25)
    if (!Number.isInteger(n) || n <= 0 || n > 25) {
      throw new Error("github.trending: limit must be 1..25")
    }
    const language = String(args.language ?? "").trim()
    const path = language ? `/trending/${encodeURIComponent(language)}` : "/trending"
    const url = new URL(`https://github.com${path}`)
    url.searchParams.set("since", since)
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; operon-site-adapters/github-trending)",
        Accept: "text/html",
      },
    })
    if (!resp.ok) throw new Error(`github.trending: HTTP ${resp.status}`)
    const html = await resp.text()
    const rows = parseTrendingHtml(html, n)
    if (rows.length === 0) {
      throw new Error(
        language
          ? `github.trending: no repos for language "${language}" (${since})`
          : `github.trending: no repos (${since})`,
      )
    }
    return rows.map((row, index) => ({ rank: index + 1, ...row }))
  },
})
