// @vitest-environment node
import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as sa from "./index.ts"
import { defineCommand } from "./define.ts"
import { ArgumentError, CommandExecutionError } from "./errors.ts"
import type { AdapterPage } from "./types.ts"

const commands = sa.list()
const sites = [...new Set(commands.map(command => command.site))]
const exportsBySite = sa as unknown as Record<string, Record<string, unknown>>

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 })
}

afterEach(() => vi.unstubAllGlobals())

describe("site discovery", () => {
  it.each(sites)("%s has a guide covering every exported function", site => {
    const guide = sa.guide(site)
    expect(guide.split("\n").length).toBeGreaterThanOrEqual(30)
    expect(guide.split("\n").length).toBeLessThanOrEqual(80)
    for (const command of commands.filter(command => command.site === site)) {
      expect(command.name).toMatch(/^[a-z][A-Za-z0-9]*$/)
      expect(exportsBySite[site][command.name]).toBe(sa.getCommand(command.id))
      expect(guide).toContain(`${site}.${command.name}`)
      expect(command).not.toHaveProperty("strategy")
      expect(command).not.toHaveProperty("columns")
      expect(sa.getCommand(command.id)?.definition).not.toHaveProperty("pipeline")
      for (const arg of command.args) expect(arg).not.toHaveProperty("positional")
    }
  })

  it("help uses the actual export name and links to the guide", () => {
    const help = sa.help("zhihu.userAnswers")
    expect(help).toContain("siteAdapters.zhihu.userAnswers(")
    expect(help).toContain("- needs Chrome: yes")
    expect(help).toContain('Site guide: siteAdapters.guide("zhihu")')
    expect(help).not.toMatch(/strategy:|columns:/)
    expect(sa.help("hackernews.newest")).toContain("- needs Chrome: no")
    expect(() => sa.guide("missing-site")).toThrow(/Sites with guides:.*xiaohongshu/)
    expect(() => sa.help("userAnswers")).toThrow(/Did you mean:.*zhihu.userAnswers/)
    expect(sa.search("小红书").some(command => command.site === "xiaohongshu")).toBe(true)
  })
})

describe("public output contracts", () => {
  it("V2EX preserves numeric fields, key order, envelopes and single-row arrays", async () => {
    const item = { id: 42, title: "Topic", node: { title: "Python" }, member: { username: "Livid" }, content: "Body", created: 1234, replies: 7, url: "https://www.v2ex.com/t/42" }
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [item] })))
    const rows = await sa.v2ex.topic({ id: "42" })
    expect(rows).toEqual([{ id: 42, title: "Topic", content: "Body", member: "Livid", created: 1234, node: "Python", replies: 7, url: item.url }])
    expect(Object.keys(rows[0])).toEqual(["id", "title", "content", "member", "created", "node", "replies", "url"])
    vi.stubGlobal("fetch", vi.fn(async () => json({ username: "Livid", tagline: "Hello", website: "", github: "livid", twitter: "", location: "Earth" })))
    expect(await sa.v2ex.member({ username: "Livid" })).toEqual([{ username: "Livid", tagline: "Hello", website: "", github: "livid", twitter: "", location: "Earth" }])
  })

  it("HN limits concurrency to five, preserves order, skips failed/dead items and re-ranks", async () => {
    let active = 0
    let maximum = 0
    const ids = Array.from({ length: 10 }, (_, index) => index + 1)
    const requests: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith("topstories.json")) return json(ids)
      const id = Number(url.match(/item\/(\d+)\.json/)?.[1])
      active++
      maximum = Math.max(maximum, active)
      try {
        await new Promise(resolve => setTimeout(resolve, (11 - id) * 2))
        if (id === 2) throw new Error("temporary item failure")
        return json({ id, title: `Story ${id}`, score: 10, by: "pg", deleted: id === 3, dead: id === 4 })
      } finally {
        active--
      }
    }))
    const rows = await sa.hackernews.top({ limit: 3 })
    expect(maximum).toBe(5)
    expect(requests).toHaveLength(11)
    expect(rows).toEqual([1, 5, 6].map((id, index) => ({ rank: index + 1, id, title: `Story ${id}`, score: 10, author: "pg", comments: undefined, url: undefined })))
    expect(Object.keys(rows[0])).toEqual(["rank", "id", "title", "score", "author", "comments", "url"])
  })

  it("HN date search sends the query and keeps Algolia string ids", async () => {
    const fetchMock = vi.fn(async (_input: string | URL) => json({ hits: [{ objectID: "123", title: "Story", points: 9, author: "pg", num_comments: 2, url: "https://example.com" }] }))
    vi.stubGlobal("fetch", fetchMock)
    const rows = await sa.hackernews.search({ query: "types & interfaces", sort: "date", limit: 1 })
    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.pathname).toBe("/api/v1/search_by_date")
    expect(url.searchParams.get("query")).toBe("types & interfaces")
    expect(url.searchParams.get("hitsPerPage")).toBe("1")
    expect(rows[0].id).toBe("123")
  })

  it("Stack Overflow keeps tag joins, booleans, timestamps and rank", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ items: [{ question_id: 1, title: "Title &amp; body", score: -2, answer_count: 3, view_count: 4, is_answered: false, tags: ["typescript", "types"], owner: { display_name: "Author" }, creation_date: 123, link: "https://stackoverflow.com/q/1" }] })))
    expect(await sa.stackoverflow.hot({ limit: 1 })).toEqual([{ rank: 1, id: 1, title: "Title &amp; body", score: -2, answers: 3, views: 4, is_answered: false, tags: "typescript, types", author: "Author", creation_date: 123, url: "https://stackoverflow.com/q/1" }])
  })

  it("Bluesky preserves missing optional fields instead of filling them in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ actors: [{ handle: "bsky.app", displayName: "Bluesky" }] })))
    expect(await sa.bluesky.search({ query: "bsky", limit: 1 })).toEqual([{ rank: 1, handle: "bsky.app", name: "Bluesky", followers: undefined, description: undefined }])
  })
})

describe("execution boundary", () => {
  it("public functions do not open a passed browser; fallback opens once", async () => {
    const open = vi.fn(async () => ({ goto: vi.fn(), playwright: { evaluate: vi.fn() } }))
    const browser = { tabs: { new: open } }
    const direct = defineCommand({ site: "contract", name: "direct", description: "Direct read", browser: false, func: async page => page === null })
    expect(await direct({ browser })).toBe(true)
    expect(open).not.toHaveBeenCalled()
    const fallback = defineCommand({ site: "contract", name: "fallback", description: "Optional browser read", browser: false, func: async (_page, _args, ctx) => {
      expect(ctx.hasBrowser).toBe(true)
      return await ctx.openPage() === await ctx.openPage()
    } })
    expect(await fallback({ browser })).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("reports typed argument and request errors", async () => {
    await expect(sa.v2ex.topic()).rejects.toBeInstanceOf(ArgumentError)
    await expect(sa.bilibili.hot()).rejects.toBeInstanceOf(ArgumentError)
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network unavailable") }))
    await expect(sa.v2ex.hot()).rejects.toBeInstanceOf(CommandExecutionError)
  })
})

describe("YouTube comments under the read-only guard", () => {
  it("reads rendered comments even with a complete Innertube bootstrap, without POST", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("No request expected") })
    const comment = { querySelector: (selector: string) => ({ innerText: ({ "#author-text": "Author", "#content-text": "Comment", "#vote-count-middle": "12", ".published-time-text": "1 day ago" } as Record<string, string>)[selector] }) }
    const ctx = { window: { scrollTo: () => {}, ytcfg: { data_: { INNERTUBE_API_KEY: "key", INNERTUBE_CONTEXT: {} } }, ytInitialData: { contents: { twoColumnWatchNextResults: { results: { results: { contents: [{ itemSectionRenderer: { targetId: "comments-section", contents: [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "continuation" } } } }] } }] } } } } } }, document: { querySelectorAll: () => [comment] }, fetch: fetchMock }
    const evaluate = async (source: string): Promise<unknown> => runInNewContext(source, ctx)
    const page: AdapterPage = { goto: async () => {}, evaluate, evaluateWrite: evaluate, cookieHeader: async () => "", fetchJson: async () => ({}), wait: async () => {}, autoScroll: async () => {}, installInterceptor: async () => {}, getInterceptedRequests: async () => [], url: async () => "", replaceTab: async () => {}, close: async () => {} }
    const definition = sa.getCommand("youtube.comments")!.definition
    const result = await definition.func(page, { url: "dQw4w9WgXcQ", limit: 2 }, { hasBrowser: true, openPage: async () => page })
    expect(result).toEqual([{ rank: 1, author: "Author", text: "Comment", likes: "12", time: "1 day ago" }])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
