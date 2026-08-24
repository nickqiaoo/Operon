/**
 * Stack Overflow — public Stack Exchange API 2.3 (no browser).
 */

import { defineCommand } from "../define.ts"

const QUESTION_MAP = {
  rank: "${{ index + 1 }}",
  id: "${{ item.question_id }}",
  title: "${{ item.title }}",
  score: "${{ item.score }}",
  answers: "${{ item.answer_count }}",
  views: "${{ item.view_count }}",
  is_answered: "${{ item.is_answered }}",
  tags: "${{ item.tags | join(', ') }}",
  author: "${{ item.owner.display_name }}",
  creation_date: "${{ item.creation_date }}",
  url: "${{ item.link }}",
}

const QUESTION_COLUMNS = [
  "rank",
  "id",
  "title",
  "score",
  "answers",
  "views",
  "is_answered",
  "tags",
  "author",
  "creation_date",
  "url",
]

export const search = defineCommand({
  site: "stackoverflow",
  name: "search",
  description: "Search Stack Overflow questions",
  domain: "stackoverflow.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [
    { name: "query", required: true, positional: true },
    { name: "limit", type: "int", default: 10 },
  ],
  columns: QUESTION_COLUMNS,
  pipeline: [
    {
      fetch: {
        url: "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${{ args.query }}&site=stackoverflow&pagesize=${{ args.limit }}",
      },
    },
    { select: "items" },
    { map: { ...QUESTION_MAP } },
    { limit: "${{ args.limit }}" },
  ],
})

export const hot = defineCommand({
  site: "stackoverflow",
  name: "hot",
  description: "Hot Stack Overflow questions",
  domain: "stackoverflow.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [{ name: "limit", type: "int", default: 10 }],
  columns: QUESTION_COLUMNS,
  pipeline: [
    {
      fetch: {
        url: "https://api.stackexchange.com/2.3/questions?order=desc&sort=hot&site=stackoverflow&pagesize=${{ args.limit }}",
      },
    },
    { select: "items" },
    { map: { ...QUESTION_MAP } },
    { limit: "${{ args.limit }}" },
  ],
})

export const unanswered = defineCommand({
  site: "stackoverflow",
  name: "unanswered",
  description: "Unanswered Stack Overflow questions",
  domain: "stackoverflow.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [{ name: "limit", type: "int", default: 10 }],
  columns: QUESTION_COLUMNS,
  pipeline: [
    {
      fetch: {
        url: "https://api.stackexchange.com/2.3/questions/unanswered?order=desc&sort=votes&site=stackoverflow&pagesize=${{ args.limit }}",
      },
    },
    { select: "items" },
    { map: { ...QUESTION_MAP } },
    { limit: "${{ args.limit }}" },
  ],
})

export const bounties = defineCommand({
  site: "stackoverflow",
  name: "bounties",
  description: "Featured (bounty) Stack Overflow questions",
  domain: "stackoverflow.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [{ name: "limit", type: "int", default: 10 }],
  columns: QUESTION_COLUMNS,
  pipeline: [
    {
      fetch: {
        url: "https://api.stackexchange.com/2.3/questions/featured?order=desc&sort=activity&site=stackoverflow&pagesize=${{ args.limit }}",
      },
    },
    { select: "items" },
    { map: { ...QUESTION_MAP } },
    { limit: "${{ args.limit }}" },
  ],
})

export const tag = defineCommand({
  site: "stackoverflow",
  name: "tag",
  description: "Questions for a Stack Overflow tag",
  domain: "stackoverflow.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [
    { name: "tag", required: true, positional: true, help: "e.g. typescript, rust" },
    { name: "limit", type: "int", default: 10 },
  ],
  columns: QUESTION_COLUMNS,
  pipeline: [
    {
      fetch: {
        url: "https://api.stackexchange.com/2.3/questions?order=desc&sort=activity&tagged=${{ args.tag }}&site=stackoverflow&pagesize=${{ args.limit }}",
      },
    },
    { select: "items" },
    { map: { ...QUESTION_MAP } },
    { limit: "${{ args.limit }}" },
  ],
})

export const read = defineCommand({
  site: "stackoverflow",
  name: "read",
  description: "Read a Stack Overflow question body + top answers",
  domain: "stackoverflow.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [
    { name: "id", required: true, positional: true, help: "Question ID (numeric)" },
    { name: "answers", type: "int", default: 3, help: "Top answers to include" },
  ],
  columns: ["kind", "id", "score", "author", "body", "url"],
  func: async (_page, args) => {
    const id = String(args.id ?? "").trim()
    if (!/^\d+$/.test(id)) throw new Error("stackoverflow.read: id must be numeric")
    const answerLimit = Math.min(Math.max(Number(args.answers) || 3, 1), 10)
    const qUrl = `https://api.stackexchange.com/2.3/questions/${id}?order=desc&sort=activity&site=stackoverflow&filter=withbody`
    const aUrl = `https://api.stackexchange.com/2.3/questions/${id}/answers?order=desc&sort=votes&site=stackoverflow&filter=withbody&pagesize=${answerLimit}`
    const [qData, aData] = await Promise.all([
      fetch(qUrl).then((r) => r.json()) as Promise<{ items?: Array<Record<string, unknown>> }>,
      fetch(aUrl).then((r) => r.json()) as Promise<{ items?: Array<Record<string, unknown>> }>,
    ])
    const q = qData.items?.[0]
    if (!q) throw new Error(`stackoverflow.read: question ${id} not found`)
    const strip = (html: unknown) =>
      String(html ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1500)
    const rows: Array<Record<string, unknown>> = [
      {
        kind: "question",
        id: q.question_id,
        score: q.score,
        author: (q.owner as { display_name?: string } | undefined)?.display_name ?? "",
        body: strip(q.body),
        url: q.link,
        title: q.title,
      },
    ]
    for (const a of aData.items ?? []) {
      rows.push({
        kind: "answer",
        id: a.answer_id,
        score: a.score,
        author: (a.owner as { display_name?: string } | undefined)?.display_name ?? "",
        body: strip(a.body),
        url: a.link ?? `https://stackoverflow.com/a/${a.answer_id}`,
        title: a.is_accepted ? "accepted" : "",
      })
    }
    return rows
  },
})

export const user = defineCommand({
  site: "stackoverflow",
  name: "user",
  description: "Stack Overflow user profile by id",
  domain: "stackoverflow.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [{ name: "id", required: true, positional: true, help: "User ID" }],
  columns: ["id", "name", "reputation", "location", "url"],
  func: async (_page, args) => {
    const id = String(args.id ?? "").trim()
    if (!/^\d+$/.test(id)) throw new Error("stackoverflow.user: id must be numeric")
    const data = (await fetch(
      `https://api.stackexchange.com/2.3/users/${id}?site=stackoverflow`,
    ).then((r) => r.json())) as { items?: Array<Record<string, unknown>> }
    const u = data.items?.[0]
    if (!u) throw new Error(`stackoverflow.user: ${id} not found`)
    return {
      id: u.user_id,
      name: u.display_name,
      reputation: u.reputation,
      location: u.location || "",
      url: u.link,
    }
  },
})
