import { defineCommand } from "../define.ts"
import { registerGuide } from "../registry.ts"
import { hostFetchJson } from "../runtime/page.ts"
import { isRecord, requireRows } from "../runtime/values.ts"
import { GUIDE } from "./guide.ts"

registerGuide("v2ex", GUIDE)

export interface V2exHotRow {
  id: number | undefined
  rank: number
  title: string | undefined
  node: string | undefined
  replies: number | undefined
  url: string | undefined
}

export interface V2exLatestRow {
  id: number | undefined
  rank: number
  title: string | undefined
  node: string | undefined
  replies: number | undefined
  url: string | undefined
}

export interface V2exTopicRow {
  id: number | undefined
  title: string | undefined
  content: string | undefined
  member: string | undefined
  created: number | undefined
  node: string | undefined
  replies: number | undefined
  url: string | undefined
}

export interface V2exRepliesRow {
  floor: number
  author: string | undefined
  content: string | undefined
}

export interface V2exMemberRow {
  username: string | undefined
  tagline: string | undefined
  website: string | undefined
  github: string | undefined
  twitter: string | undefined
  location: string | undefined
}

export interface V2exNodeRow {
  rank: number
  title: string | undefined
  author: string | undefined
  replies: number | undefined
  url: string | undefined
}

export interface V2exUserRow {
  rank: number
  title: string | undefined
  node: string | undefined
  replies: number | undefined
  url: string | undefined
}

export const hot = defineCommand({
  site: "v2ex",
  name: "hot",
  description: "V2EX hot topics",
  keywords: ["热门", "热议"],
  domain: "www.v2ex.com",
  access: "read",
  browser: false,
  args: [{ name: "limit", type: "int", default: 20, help: "Number of topics" }],
  func: async (_page, args): Promise<V2exHotRow[]> => {
    const payload = await hostFetchJson(`https://www.v2ex.com/api/topics/hot.json`)
    const rows = requireRows(payload, "v2ex").map((raw, index) => {
      const item = raw
      return {
        id: item.id as number | undefined,
        rank: index + 1,
        title: item.title as string | undefined,
        node: (isRecord(item.node) ? item.node.title : undefined) as string | undefined,
        replies: item.replies as number | undefined,
        url: item.url as string | undefined,
      }
    })
    return rows.slice(0, Number(args.limit))
  },
})

export const latest = defineCommand({
  site: "v2ex",
  name: "latest",
  description: "V2EX latest topics",
  keywords: ["最新", "最近"],
  domain: "www.v2ex.com",
  access: "read",
  browser: false,
  args: [{ name: "limit", type: "int", default: 20, help: "Number of topics" }],
  func: async (_page, args): Promise<V2exLatestRow[]> => {
    const payload = await hostFetchJson(`https://www.v2ex.com/api/topics/latest.json`)
    const rows = requireRows(payload, "v2ex").map((raw, index) => {
      const item = raw
      return {
        id: item.id as number | undefined,
        rank: index + 1,
        title: item.title as string | undefined,
        node: (isRecord(item.node) ? item.node.title : undefined) as string | undefined,
        replies: item.replies as number | undefined,
        url: item.url as string | undefined,
      }
    })
    return rows.slice(0, Number(args.limit))
  },
})

export const topic = defineCommand({
  site: "v2ex",
  name: "topic",
  description: "V2EX topic detail with replies",
  domain: "www.v2ex.com",
  access: "read",
  browser: false,
  args: [{ name: "id", required: true, help: "Topic ID" }],
  func: async (_page, args): Promise<V2exTopicRow[]> => {
    const payload = await hostFetchJson(`https://www.v2ex.com/api/topics/show.json` + "?" + new URLSearchParams({ id: String(args.id) }).toString())
    const rows = requireRows(payload, "v2ex").map((raw) => {
      const item = raw
      return {
        id: item.id as number | undefined,
        title: item.title as string | undefined,
        content: item.content as string | undefined,
        member: (isRecord(item.member) ? item.member.username : undefined) as string | undefined,
        created: item.created as number | undefined,
        node: (isRecord(item.node) ? item.node.title : undefined) as string | undefined,
        replies: item.replies as number | undefined,
        url: item.url as string | undefined,
      }
    })
    return rows.slice(0, Number(1))
  },
})

export const replies = defineCommand({
  site: "v2ex",
  name: "replies",
  description: "V2EX topic reply list",
  domain: "www.v2ex.com",
  access: "read",
  browser: false,
  args: [
    { name: "id", required: true, help: "Topic ID" },
    { name: "limit", type: "int", default: 20, help: "Number of replies" },
  ],
  func: async (_page, args): Promise<V2exRepliesRow[]> => {
    const payload = await hostFetchJson(`https://www.v2ex.com/api/replies/show.json` + "?" + new URLSearchParams({ topic_id: String(args.id) }).toString())
    const rows = requireRows(payload, "v2ex").map((raw, index) => {
      const item = raw
      return {
        floor: index + 1,
        author: (isRecord(item.member) ? item.member.username : undefined) as string | undefined,
        content: item.content as string | undefined,
      }
    })
    return rows.slice(0, Number(args.limit))
  },
})

export const member = defineCommand({
  site: "v2ex",
  name: "member",
  description: "V2EX user profile",
  domain: "www.v2ex.com",
  access: "read",
  browser: false,
  args: [{ name: "username", required: true, help: "Username" }],
  func: async (_page, args): Promise<V2exMemberRow[]> => {
    const payload = await hostFetchJson(`https://www.v2ex.com/api/members/show.json` + "?" + new URLSearchParams({ username: String(args.username) }).toString())
    const rows = requireRows(payload, "v2ex").map((raw) => {
      const item = raw
      return {
        username: item.username as string | undefined,
        tagline: item.tagline as string | undefined,
        website: item.website as string | undefined,
        github: item.github as string | undefined,
        twitter: item.twitter as string | undefined,
        location: item.location as string | undefined,
      }
    })
    return rows
  },
})

export const node = defineCommand({
  site: "v2ex",
  name: "node",
  description: "V2EX topics in a node",
  domain: "www.v2ex.com",
  access: "read",
  browser: false,
  args: [
    {
      name: "name",
      required: true,

      help: "Node name (e.g. python, javascript, apple)",
    },
    { name: "limit", type: "int", default: 10, help: "Number of topics (API max ~20)" },
  ],
  func: async (_page, args): Promise<V2exNodeRow[]> => {
    const payload = await hostFetchJson(`https://www.v2ex.com/api/topics/show.json` + "?" + new URLSearchParams({ node_name: String(args.name) }).toString())
    const rows = requireRows(payload, "v2ex").map((raw, index) => {
      const item = raw
      return {
        rank: index + 1,
        title: item.title as string | undefined,
        author: (isRecord(item.member) ? item.member.username : undefined) as string | undefined,
        replies: item.replies as number | undefined,
        url: item.url as string | undefined,
      }
    })
    return rows.slice(0, Number(args.limit))
  },
})

export const user = defineCommand({
  site: "v2ex",
  name: "user",
  description: "V2EX topics posted by a user",
  domain: "www.v2ex.com",
  access: "read",
  browser: false,
  args: [
    { name: "username", required: true, help: "Username" },
    { name: "limit", type: "int", default: 10, help: "Number of topics (API max ~20)" },
  ],
  func: async (_page, args): Promise<V2exUserRow[]> => {
    const payload = await hostFetchJson(`https://www.v2ex.com/api/topics/show.json` + "?" + new URLSearchParams({ username: String(args.username) }).toString())
    const rows = requireRows(payload, "v2ex").map((raw, index) => {
      const item = raw
      return {
        rank: index + 1,
        title: item.title as string | undefined,
        node: (isRecord(item.node) ? item.node.title : undefined) as string | undefined,
        replies: item.replies as number | undefined,
        url: item.url as string | undefined,
      }
    })
    return rows.slice(0, Number(args.limit))
  },
})
