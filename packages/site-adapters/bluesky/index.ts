import { defineCommand } from "../define.ts"
import { ArgumentError, CommandExecutionError } from "../errors.ts"
import { registerGuide } from "../registry.ts"
import { hostFetchJson } from "../runtime/page.ts"
import { isRecord, requireRows } from "../runtime/values.ts"
import { GUIDE } from "./guide.ts"

export interface BlueskyProfileRow {
  handle: unknown
  name: unknown
  followers: unknown
  follows: unknown
  posts: unknown
  description: unknown
  url: string
}

export interface BlueskyFeedRow {
  rank: number
  text: string
  likes: number
  reposts: number
  replies: number
  uri: unknown
  created: unknown
}

export interface BlueskyThreadRow {
  depth: number
  handle: unknown
  text: string
  likes: unknown
  uri: unknown
}

export interface BlueskyFollowersRow {
  rank: number
  handle: unknown
  name: unknown
  description: string
}

export interface BlueskyFollowingRow {
  rank: number
  handle: unknown
  name: unknown
  description: string
}

registerGuide("bluesky", GUIDE)

export interface BlueskyTrendingRow {
  rank: number
  topic: string | undefined
  link: string | undefined
}

export interface BlueskySearchRow {
  rank: number
  handle: string | undefined
  name: string | undefined
  followers: number | undefined
  description: string | undefined
}

/**
 * Bluesky public API (public.api.bsky.app) — no browser.
 */

export const trending = defineCommand({
  site: "bluesky",
  name: "trending",
  description: "Trending topics on Bluesky",
  domain: "public.api.bsky.app",
  access: "read",
  browser: false,
  args: [{ name: "limit", type: "int", default: 20 }],
  func: async (_page, args): Promise<BlueskyTrendingRow[]> => {
    const payload = await hostFetchJson(`https://public.api.bsky.app/xrpc/app.bsky.unspecced.getTrendingTopics`)
    if (!isRecord(payload)) throw new CommandExecutionError("bluesky.trending: unexpected response")
    const items = payload.topics
    const rows = requireRows(items, "bluesky.trending").map((item, index) => {
      return {
        rank: index + 1,
        topic: item.topic as string | undefined,
        link: item.link as string | undefined,
      }
    })
    return rows.slice(0, Number(args.limit))
  },
})

export const search = defineCommand({
  site: "bluesky",
  name: "search",
  description: "Search Bluesky users",
  domain: "public.api.bsky.app",
  access: "read",
  browser: false,
  args: [
    { name: "query", required: true },
    { name: "limit", type: "int", default: 10 },
  ],
  func: async (_page, args): Promise<BlueskySearchRow[]> => {
    const payload = await hostFetchJson(`https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=${args.query}&limit=${args.limit}`)
    if (!isRecord(payload)) throw new CommandExecutionError("bluesky.search: unexpected response")
    const items = payload.actors
    const rows = requireRows(items, "bluesky.search").map((item, index) => {
      return {
        rank: index + 1,
        handle: item.handle as string | undefined,
        name: item.displayName as string | undefined,
        followers: item.followersCount as number | undefined,
        description: item.description as string | undefined,
      }
    })
    return rows.slice(0, Number(args.limit))
  },
})

export const profile = defineCommand({
  site: "bluesky",
  name: "profile",
  description: "Get Bluesky actor profile",
  domain: "public.api.bsky.app",
  access: "read",
  browser: false,
  args: [{ name: "actor", required: true, help: "handle or DID" }],
  func: async (_page, args): Promise<BlueskyProfileRow> => {
    const actor = encodeURIComponent(String(args.actor ?? "").trim())
    if (!actor) throw new ArgumentError("bluesky.profile: actor required")
    const data = (await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${actor}`,
    ).then((r) => {
      if (!r.ok) throw new CommandExecutionError(`bluesky.profile: HTTP ${r.status}`)
      return r.json()
    })) as Record<string, unknown>
    return {
      handle: data.handle,
      name: data.displayName || "",
      followers: data.followersCount ?? 0,
      follows: data.followsCount ?? 0,
      posts: data.postsCount ?? 0,
      description: data.description || "",
      url: data.handle ? `https://bsky.app/profile/${data.handle}` : "",
    }
  },
})

export const feed = defineCommand({
  site: "bluesky",
  name: "feed",
  description: "Author feed (recent posts)",
  domain: "public.api.bsky.app",
  access: "read",
  browser: false,
  args: [
    { name: "actor", required: true },
    { name: "limit", type: "int", default: 20 },
  ],
  func: async (_page, args): Promise<BlueskyFeedRow[]> => {
    const actor = encodeURIComponent(String(args.actor ?? "").trim())
    const limit = Math.min(Number(args.limit) || 20, 50)
    const data = (await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${actor}&limit=${limit}`,
    ).then((r) => {
      if (!r.ok) throw new CommandExecutionError(`bluesky.feed: HTTP ${r.status}`)
      return r.json()
    })) as { feed?: Array<Record<string, unknown>> }
    const items = data.feed ?? []
    return items.map((row, i) => {
      const post = (row.post ?? {}) as Record<string, unknown>
      const record = (post.record ?? {}) as Record<string, unknown>
      return {
        rank: i + 1,
        text: String(record.text || "").slice(0, 280),
        likes: (post.likeCount as number) ?? 0,
        reposts: (post.repostCount as number) ?? 0,
        replies: (post.replyCount as number) ?? 0,
        uri: post.uri ?? "",
        created: record.createdAt ?? "",
      }
    })
  },
})

export const thread = defineCommand({
  site: "bluesky",
  name: "thread",
  description: "Fetch a Bluesky post thread by AT URI or bsky.app URL",
  domain: "public.api.bsky.app",
  access: "read",
  browser: false,
  args: [
    { name: "uri", required: true, help: "at://… URI or bsky.app post URL" },
    { name: "depth", type: "int", default: 6 },
  ],
  func: async (_page, args): Promise<BlueskyThreadRow[]> => {
    let uri = String(args.uri ?? "").trim()
    // https://bsky.app/profile/handle/post/rkey → resolve via getPostThread accepts at://
    if (uri.startsWith("https://bsky.app/")) {
      const m = uri.match(/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/)
      if (m) {
        // Need DID resolution — use getPosts after resolveHandle
        const handle = m[1]!
        const rkey = m[2]!
        const resolved = (await fetch(
          `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
        ).then((r) => r.json())) as { did?: string }
        if (!resolved.did) throw new CommandExecutionError(`bluesky.thread: cannot resolve handle ${handle}`)
        uri = `at://${resolved.did}/app.bsky.feed.post/${rkey}`
      }
    }
    if (!uri.startsWith("at://")) throw new ArgumentError("bluesky.thread: need at:// URI or bsky.app URL")
    const depth = Math.min(Number(args.depth) || 6, 10)
    const data = (await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=${depth}`,
    ).then((r) => {
      if (!r.ok) throw new CommandExecutionError(`bluesky.thread: HTTP ${r.status}`)
      return r.json()
    })) as { thread?: unknown }

    const rows: BlueskyThreadRow[] = []
    const walk = (node: unknown, d: number) => {
      if (!node || typeof node !== "object") return
      const n = node as Record<string, unknown>
      const post = (n.post ?? n) as Record<string, unknown>
      if (post.uri && post.record) {
        const author = (post.author ?? {}) as Record<string, unknown>
        const record = (post.record ?? {}) as Record<string, unknown>
        rows.push({
          depth: d,
          handle: author.handle ?? "",
          text: String(record.text || "").slice(0, 280),
          likes: post.likeCount ?? 0,
          uri: post.uri,
        })
      }
      const replies = n.replies
      if (Array.isArray(replies)) {
        for (const r of replies) walk(r, d + 1)
      }
    }
    walk(data.thread, 0)
    return (rows) as BlueskyThreadRow[]
  },
})

export const followers = defineCommand({
  site: "bluesky",
  name: "followers",
  description: "List Bluesky followers",
  domain: "public.api.bsky.app",
  access: "read",
  browser: false,
  args: [
    { name: "actor", required: true },
    { name: "limit", type: "int", default: 20 },
  ],
  func: async (_page, args): Promise<BlueskyFollowersRow[]> => {
    const actor = encodeURIComponent(String(args.actor ?? "").trim())
    const limit = Math.min(Number(args.limit) || 20, 50)
    const data = (await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.graph.getFollowers?actor=${actor}&limit=${limit}`,
    ).then((r) => {
      if (!r.ok) throw new CommandExecutionError(`bluesky.followers: HTTP ${r.status}`)
      return r.json()
    })) as { followers?: Array<Record<string, unknown>> }
    return (data.followers ?? []).map((f, i) => ({
      rank: i + 1,
      handle: f.handle,
      name: f.displayName || "",
      description: String(f.description || "").slice(0, 120),
    }))
  },
})

export const following = defineCommand({
  site: "bluesky",
  name: "following",
  description: "List accounts a Bluesky actor follows",
  domain: "public.api.bsky.app",
  access: "read",
  browser: false,
  args: [
    { name: "actor", required: true },
    { name: "limit", type: "int", default: 20 },
  ],
  func: async (_page, args): Promise<BlueskyFollowingRow[]> => {
    const actor = encodeURIComponent(String(args.actor ?? "").trim())
    const limit = Math.min(Number(args.limit) || 20, 50)
    const data = (await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows?actor=${actor}&limit=${limit}`,
    ).then((r) => {
      if (!r.ok) throw new CommandExecutionError(`bluesky.following: HTTP ${r.status}`)
      return r.json()
    })) as { follows?: Array<Record<string, unknown>> }
    return (data.follows ?? []).map((f, i) => ({
      rank: i + 1,
      handle: f.handle,
      name: f.displayName || "",
      description: String(f.description || "").slice(0, 120),
    }))
  },
})
