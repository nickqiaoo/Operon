import { defineCommand } from "../define.ts"

export const hot = defineCommand({
  site: "v2ex",
  name: "hot",
  description: "V2EX hot topics",
  keywords: ["热门", "热议"],
  domain: "www.v2ex.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [{ name: "limit", type: "int", default: 20, help: "Number of topics" }],
  columns: ["id", "rank", "title", "node", "replies", "url"],
  pipeline: [
    { fetch: { url: "https://www.v2ex.com/api/topics/hot.json" } },
    {
      map: {
        id: "${{ item.id }}",
        rank: "${{ index + 1 }}",
        title: "${{ item.title }}",
        node: "${{ item.node.title }}",
        replies: "${{ item.replies }}",
        url: "${{ item.url }}",
      },
    },
    { limit: "${{ args.limit }}" },
  ],
})

export const latest = defineCommand({
  site: "v2ex",
  name: "latest",
  description: "V2EX latest topics",
  keywords: ["最新", "最近"],
  domain: "www.v2ex.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [{ name: "limit", type: "int", default: 20, help: "Number of topics" }],
  columns: ["id", "rank", "title", "node", "replies", "url"],
  pipeline: [
    { fetch: { url: "https://www.v2ex.com/api/topics/latest.json" } },
    {
      map: {
        id: "${{ item.id }}",
        rank: "${{ index + 1 }}",
        title: "${{ item.title }}",
        node: "${{ item.node.title }}",
        replies: "${{ item.replies }}",
        url: "${{ item.url }}",
      },
    },
    { limit: "${{ args.limit }}" },
  ],
})

export const topic = defineCommand({
  site: "v2ex",
  name: "topic",
  description: "V2EX topic detail with replies",
  domain: "www.v2ex.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [{ name: "id", required: true, positional: true, help: "Topic ID" }],
  columns: ["id", "title", "content", "member", "created", "node", "replies", "url"],
  pipeline: [
    {
      fetch: {
        url: "https://www.v2ex.com/api/topics/show.json",
        params: { id: "${{ args.id }}" },
      },
    },
    {
      map: {
        id: "${{ item.id }}",
        title: "${{ item.title }}",
        content: "${{ item.content }}",
        member: "${{ item.member.username }}",
        created: "${{ item.created }}",
        node: "${{ item.node.title }}",
        replies: "${{ item.replies }}",
        url: "${{ item.url }}",
      },
    },
    { limit: 1 },
  ],
})

export const replies = defineCommand({
  site: "v2ex",
  name: "replies",
  description: "V2EX topic reply list",
  domain: "www.v2ex.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [
    { name: "id", required: true, positional: true, help: "Topic ID" },
    { name: "limit", type: "int", default: 20, help: "Number of replies" },
  ],
  columns: ["floor", "author", "content"],
  pipeline: [
    {
      fetch: {
        url: "https://www.v2ex.com/api/replies/show.json",
        params: { topic_id: "${{ args.id }}" },
      },
    },
    {
      map: {
        floor: "${{ index + 1 }}",
        author: "${{ item.member.username }}",
        content: "${{ item.content }}",
      },
    },
    { limit: "${{ args.limit }}" },
  ],
})

export const member = defineCommand({
  site: "v2ex",
  name: "member",
  description: "V2EX user profile",
  domain: "www.v2ex.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [{ name: "username", required: true, positional: true, help: "Username" }],
  columns: ["username", "tagline", "website", "github", "twitter", "location"],
  pipeline: [
    {
      fetch: {
        url: "https://www.v2ex.com/api/members/show.json",
        params: { username: "${{ args.username }}" },
      },
    },
    {
      map: {
        username: "${{ item.username }}",
        tagline: "${{ item.tagline }}",
        website: "${{ item.website }}",
        github: "${{ item.github }}",
        twitter: "${{ item.twitter }}",
        location: "${{ item.location }}",
      },
    },
  ],
})

export const node = defineCommand({
  site: "v2ex",
  name: "node",
  description: "V2EX topics in a node",
  domain: "www.v2ex.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [
    {
      name: "name",
      required: true,
      positional: true,
      help: "Node name (e.g. python, javascript, apple)",
    },
    { name: "limit", type: "int", default: 10, help: "Number of topics (API max ~20)" },
  ],
  columns: ["rank", "title", "author", "replies", "url"],
  pipeline: [
    {
      fetch: {
        url: "https://www.v2ex.com/api/topics/show.json",
        params: { node_name: "${{ args.name }}" },
      },
    },
    {
      map: {
        rank: "${{ index + 1 }}",
        title: "${{ item.title }}",
        author: "${{ item.member.username }}",
        replies: "${{ item.replies }}",
        url: "${{ item.url }}",
      },
    },
    { limit: "${{ args.limit }}" },
  ],
})

export const user = defineCommand({
  site: "v2ex",
  name: "user",
  description: "V2EX topics posted by a user",
  domain: "www.v2ex.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [
    { name: "username", required: true, positional: true, help: "Username" },
    { name: "limit", type: "int", default: 10, help: "Number of topics (API max ~20)" },
  ],
  columns: ["rank", "title", "node", "replies", "url"],
  pipeline: [
    {
      fetch: {
        url: "https://www.v2ex.com/api/topics/show.json",
        params: { username: "${{ args.username }}" },
      },
    },
    {
      map: {
        rank: "${{ index + 1 }}",
        title: "${{ item.title }}",
        node: "${{ item.node.title }}",
        replies: "${{ item.replies }}",
        url: "${{ item.url }}",
      },
    },
    { limit: "${{ args.limit }}" },
  ],
})
