import { describe, expect, it } from "vitest"
import { list, run, search } from "../registry.ts"
// Import package sites so commands register
import "../index.ts"
import { parseLimit } from "./hot.ts"

describe("parseLimit", () => {
  it("defaults and caps", () => {
    expect(parseLimit(undefined)).toBe(20)
    expect(parseLimit(5)).toBe(5)
    expect(parseLimit(100)).toBe(50)
  })

  it("rejects invalid", () => {
    expect(() => parseLimit(0)).toThrow(/positive integer/)
    expect(() => parseLimit(1.5)).toThrow(/positive integer/)
  })
})

describe("registry", () => {
  it("lists site packages including tier-1 international sites", () => {
    const ids = list().map((c) => c.id)
    for (const id of [
      "bilibili.hot",
      "zhihu.search",
      "reddit.hot",
      "twitter.profile",
      "hackernews.top",
      "v2ex.hot",
      "github.trending",
      "youtube.search",
      "wikipedia.summary",
      "arxiv.search",
      "stackoverflow.hot",
      "bluesky.trending",
      "producthunt.today",
    ]) {
      expect(ids).toContain(id)
    }
    expect(ids.some((id) => id.startsWith("douban."))).toBe(false)
  })


  it("finds hot-feed commands by their native-language term", () => {
    const hits = search("热门").map((c) => c.id)
    expect(hits.some((id) => id.includes("bilibili") || id.includes("v2ex") || id.includes("zhihu"))).toBe(
      true,
    )
  })
})

describe("hot (mock browser)", () => {
  it("navigates, evaluates, maps, and ranks", async () => {
    const gotos: string[] = []
    const evalSources: string[] = []

    const browser = {
      tabs: {
        new: async () => ({
          goto: async (url: string) => {
            gotos.push(url)
          },
          playwright: {
            evaluate: async <T>(src: string | ((...args: never[]) => unknown)): Promise<T> => {
              evalSources.push(typeof src === "string" ? src : String(src))
              return [
                {
                  title: "T",
                  author: "U",
                  play: 9,
                  danmaku: 1,
                  bvid: "BVxx",
                  url: "https://www.bilibili.com/video/BVxx",
                },
              ] as T
            },
          },
        }),
      },
    }

    const videos = await run("bilibili.hot", { limit: 5, browser })
    expect(gotos).toEqual(["https://www.bilibili.com"])
    expect(evalSources[0]).toContain("ps=5")
    expect(videos).toEqual([
      {
        rank: 1,
        title: "T",
        author: "U",
        play: 9,
        danmaku: 1,
        bvid: "BVxx",
        url: "https://www.bilibili.com/video/BVxx",
      },
    ])
  })

  it("requires browser for cookie commands", async () => {
    await expect(run("bilibili.hot", { limit: 3 })).rejects.toThrow(/browser is required/)
  })
})

describe("public run (optional network)", () => {
  it("hackernews.top does not require browser", async () => {
    // May hit real network; skip soft if offline
    try {
      const rows = (await run("hackernews.top", { limit: 2 })) as Array<{ rank: number; title: string }>
      expect(Array.isArray(rows)).toBe(true)
      if (rows.length > 0) {
        expect(rows[0]!.rank).toBe(1)
        expect(typeof rows[0]!.title).toBe("string")
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/fetch|network|ENOTFOUND|ECONN|HTTP/i.test(msg)) {
        // offline CI — acceptable
        return
      }
      throw e
    }
  }, 30_000)
})
