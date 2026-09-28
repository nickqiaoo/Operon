import { defineCommand } from "../define.ts"
import { registerGuide } from "../registry.ts"
import { GUIDE } from "./guide.ts"
import type { PostRow } from "./utils.ts"
import { fetchFeed, PRODUCTHUNT_CATEGORY_SLUGS } from "./utils.ts"

export interface ProducthuntTodayRow {
  rank: number
  name: string
  tagline: string
  author: string
  url: string
}

registerGuide("producthunt", GUIDE)

export type { PostRow } from "./utils.ts"

export const posts = defineCommand({
  site: "producthunt",
  name: "posts",
  description: "Latest Product Hunt launches (Atom feed)",
  domain: "www.producthunt.com",
  access: "read",
  browser: false,
  args: [
    { name: "limit", type: "int", default: 20 },
    {
      name: "category",
      default: "",
      help: `Optional: ${PRODUCTHUNT_CATEGORY_SLUGS.slice(0, 6).join(", ")}…`,
    },
  ],
  func: async (_page, args): Promise<PostRow[]> => {
    const count = Math.min(Number(args.limit) || 20, 50)
    const category = String(args.category ?? "").trim() || undefined
    const postsList = await fetchFeed(category)
    return (postsList.slice(0, count)) as PostRow[]
  },
})

export const today = defineCommand({
  site: "producthunt",
  name: "today",
  description: "Today's Product Hunt launches (from feed latest date)",
  domain: "www.producthunt.com",
  access: "read",
  browser: false,
  args: [{ name: "limit", type: "int", default: 20 }],
  func: async (_page, args): Promise<ProducthuntTodayRow[]> => {
    const count = Math.min(Number(args.limit) || 20, 50)
    const postsList = await fetchFeed()
    if (postsList.length === 0) return []
    const latestDate = postsList.map((p) => String(p.date)).sort().reverse()[0]
    const todayPosts = postsList.filter((p) => p.date === latestDate)
    return todayPosts.slice(0, count).map((p, i) => ({
      rank: i + 1,
      name: p.name,
      tagline: p.tagline,
      author: p.author,
      url: p.url,
    }))
  },
})

export const hot = defineCommand({
  site: "producthunt",
  name: "hot",
  description: "Recent Product Hunt feed (alias of posts)",
  domain: "www.producthunt.com",
  access: "read",
  browser: false,
  args: [{ name: "limit", type: "int", default: 20 }],
  func: async (_page, args): Promise<PostRow[]> => {
    const count = Math.min(Number(args.limit) || 20, 50)
    return ((await fetchFeed()).slice(0, count)) as PostRow[]
  },
})
