import { defineCommand } from "../define.ts"
import { CommandExecutionError, errorMessage } from "../errors.ts"
import { hostFetchJson } from "../runtime/page.ts"
import { isRecord } from "../runtime/values.ts"
import type { CommandDefinition } from "../types.ts"

export interface StoryRow {
  rank: number
  id: number | undefined
  title: string | undefined
  score: number | undefined
  author: string | undefined
  comments: number | undefined
  url: string | undefined
}

/** Five workers retain input order and isolate individual item failures. */
async function fetchStories(ids: unknown[]): Promise<unknown[]> {
  const results = new Array<unknown>(ids.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < ids.length) {
      const index = next++
      try {
        results[index] = await hostFetchJson(`https://hacker-news.firebaseio.com/v0/item/${ids[index]}.json`)
      } catch (error) {
        results[index] = { error: errorMessage(error) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, ids.length) }, worker))
  return results
}

function storyList(def: { name: string; description: string; path: string }): CommandDefinition<StoryRow[]> {
  return {
    site: "hackernews",
    name: def.name,
    description: def.description,
    domain: "news.ycombinator.com",
    access: "read",
    browser: false,
    args: [{ name: "limit", type: "int", default: 20, help: "Number of stories" }],
    func: async (_page, args): Promise<StoryRow[]> => {
      const ids = await hostFetchJson(`https://hacker-news.firebaseio.com/v0/${def.path}.json`)
      if (!Array.isArray(ids)) throw new CommandExecutionError(`hackernews.${def.name}: unexpected response`)
      const candidates = ids.slice(0, Math.min((Number(args.limit) || 20) + 10, 50))
      const items = await fetchStories(candidates)
      return items
        .filter((item): item is Record<string, unknown> => isRecord(item) && Boolean(item.title && !item.deleted && !item.dead))
        .map((item, index) => ({
          rank: index + 1,
          id: item.id as number | undefined,
          title: item.title as string | undefined,
          score: item.score as number | undefined,
          author: item.by as string | undefined,
          comments: item.descendants as number | undefined,
          url: item.url as string | undefined,
        }))
        .slice(0, Number(args.limit))
    },
  }
}

export const top = defineCommand(storyList({ name: "top", description: "Hacker News top stories", path: "topstories" }))
export const newest = defineCommand(storyList({ name: "newest", description: "Hacker News newest stories", path: "newstories" }))
export const best = defineCommand(storyList({ name: "best", description: "Hacker News best stories", path: "beststories" }))
export const ask = defineCommand(storyList({ name: "ask", description: "Hacker News Ask HN posts", path: "askstories" }))
export const show = defineCommand(storyList({ name: "show", description: "Hacker News Show HN posts", path: "showstories" }))
export const jobs = defineCommand(storyList({ name: "jobs", description: "Hacker News jobs", path: "jobstories" }))
