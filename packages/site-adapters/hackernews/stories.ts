import { defineCommand } from "../define.ts"
import type { CommandDefinition } from "../types.ts"

/** Shared HN story-list pipeline (top/new/best/ask/show/jobs). */
function storyList(def: {
  name: string
  description: string
  path: string
}): CommandDefinition {
  return {
    site: "hackernews",
    name: def.name,
    description: def.description,
    domain: "news.ycombinator.com",
    access: "read",
    strategy: "public",
    browser: false,
    args: [{ name: "limit", type: "int", default: 20, help: "Number of stories" }],
    columns: ["rank", "id", "title", "score", "author", "comments", "url"],
    pipeline: [
      { fetch: { url: `https://hacker-news.firebaseio.com/v0/${def.path}.json` } },
      { limit: "${{ Math.min((args.limit ? args.limit : 20) + 10, 50) }}" },
      { map: { id: "${{ item }}" } },
      { fetch: { url: "https://hacker-news.firebaseio.com/v0/item/${{ item.id }}.json" } },
      { filter: "item.title && !item.deleted && !item.dead" },
      {
        map: {
          rank: "${{ index + 1 }}",
          id: "${{ item.id }}",
          title: "${{ item.title }}",
          score: "${{ item.score }}",
          author: "${{ item.by }}",
          comments: "${{ item.descendants }}",
          url: "${{ item.url }}",
        },
      },
      { limit: "${{ args.limit }}" },
    ],
  }
}

export const top = defineCommand(
  storyList({ name: "top", description: "Hacker News top stories", path: "topstories" }),
)
export const newest = defineCommand(
  storyList({ name: "new", description: "Hacker News newest stories", path: "newstories" }),
)
export const best = defineCommand(
  storyList({ name: "best", description: "Hacker News best stories", path: "beststories" }),
)
export const ask = defineCommand(
  storyList({ name: "ask", description: "Hacker News Ask HN posts", path: "askstories" }),
)
export const show = defineCommand(
  storyList({ name: "show", description: "Hacker News Show HN posts", path: "showstories" }),
)
export const jobs = defineCommand(
  storyList({ name: "jobs", description: "Hacker News jobs", path: "jobstories" }),
)
