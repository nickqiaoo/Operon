import { defineCommand } from "../define.ts"
import { CommandExecutionError } from "../errors.ts"
import { hostFetchJson } from "../runtime/page.ts"
import { isRecord, requireRows } from "../runtime/values.ts"

export interface HackernewsSearchRow {
  rank: number
  id: number | string | undefined
  title: string | undefined
  score: number | undefined
  author: string | undefined
  comments: number | undefined
  url: string | undefined
}

export const search = defineCommand({
  site: "hackernews",
  name: "search",
  description: "Search Hacker News stories",
  domain: "news.ycombinator.com",
  access: "read",
  browser: false,
  args: [
    { name: "query", required: true, help: "Search query" },
    { name: "limit", type: "int", default: 20, help: "Number of results" },
    {
      name: "sort",
      default: "relevance",
      help: "Sort by relevance or date",
      choices: ["relevance", "date"],
    },
  ],
  func: async (_page, args): Promise<HackernewsSearchRow[]> => {
    const endpoint = args.sort === "date" ? "https://hn.algolia.com/api/v1/search_by_date" : "https://hn.algolia.com/api/v1/search"
    const query = new URLSearchParams({ query: String(args.query), tags: "story", hitsPerPage: String(args.limit) })
    const payload = await hostFetchJson(`${endpoint}?${query}`)
    if (!isRecord(payload)) throw new CommandExecutionError("hackernews.search: unexpected response")
    const items = payload.hits
    const rows = requireRows(items, "hackernews.search").map((item, index) => {
      return {
        rank: index + 1,
        id: item.objectID as number | string | undefined,
        title: item.title as string | undefined,
        score: item.points as number | undefined,
        author: item.author as string | undefined,
        comments: item.num_comments as number | undefined,
        url: item.url as string | undefined,
      }
    })
    return rows.slice(0, Number(args.limit))
  },
})
