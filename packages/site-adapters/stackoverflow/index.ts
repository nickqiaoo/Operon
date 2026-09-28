import { defineCommand } from "../define.ts"
import { ArgumentError, CommandExecutionError, EmptyResultError } from "../errors.ts"
import { registerGuide } from "../registry.ts"
import { hostFetchJson } from "../runtime/page.ts"
import { isRecord, requireRows } from "../runtime/values.ts"
import { GUIDE } from "./guide.ts"

export interface StackoverflowReadRow {
  kind: "question" | "answer"
  id: unknown
  score: unknown
  author: string
  body: string
  url: unknown
  title: unknown
}

export interface StackoverflowUserRow {
  id: unknown
  name: unknown
  reputation: unknown
  location: unknown
  url: unknown
}

registerGuide("stackoverflow", GUIDE)

export interface QuestionRow {
  rank: number
  id: number | undefined
  title: string | undefined
  score: number | undefined
  answers: number | undefined
  views: number | undefined
  is_answered: boolean | undefined
  tags: string | undefined
  author: string | undefined
  creation_date: number | undefined
  url: string | undefined
}

/**
 * Stack Overflow — public Stack Exchange API 2.3 (no browser).
 */

function questionRows(value: unknown, command: string): QuestionRow[] {
  return requireRows(value, command).map((item, index) => {
    return {
      rank: index + 1,
      id: item.question_id as number | undefined,
      title: item.title as string | undefined,
      score: item.score as number | undefined,
      answers: item.answer_count as number | undefined,
      views: item.view_count as number | undefined,
      is_answered: item.is_answered as boolean | undefined,
      tags: (Array.isArray(item.tags) ? item.tags.join(', ') : item.tags) as string | undefined,
      author: (isRecord(item.owner) ? item.owner.display_name : undefined) as string | undefined,
      creation_date: item.creation_date as number | undefined,
      url: item.link as string | undefined,
    }
  })
}

export const search = defineCommand({
  site: "stackoverflow",
  name: "search",
  description: "Search Stack Overflow questions",
  domain: "stackoverflow.com",
  access: "read",
  browser: false,
  args: [
    { name: "query", required: true },
    { name: "limit", type: "int", default: 10 },
  ],
  func: async (_page, args): Promise<QuestionRow[]> => {
    const payload = await hostFetchJson(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${args.query}&site=stackoverflow&pagesize=${args.limit}`)
    if (!isRecord(payload)) throw new CommandExecutionError("stackoverflow.search: unexpected response")
    const items = payload.items
    const rows = questionRows(items, "stackoverflow.search")
    return rows.slice(0, Number(args.limit))
  },
})

export const hot = defineCommand({
  site: "stackoverflow",
  name: "hot",
  description: "Hot Stack Overflow questions",
  domain: "stackoverflow.com",
  access: "read",
  browser: false,
  args: [{ name: "limit", type: "int", default: 10 }],
  func: async (_page, args): Promise<QuestionRow[]> => {
    const payload = await hostFetchJson(`https://api.stackexchange.com/2.3/questions?order=desc&sort=hot&site=stackoverflow&pagesize=${args.limit}`)
    if (!isRecord(payload)) throw new CommandExecutionError("stackoverflow.hot: unexpected response")
    const items = payload.items
    const rows = questionRows(items, "stackoverflow.hot")
    return rows.slice(0, Number(args.limit))
  },
})

export const unanswered = defineCommand({
  site: "stackoverflow",
  name: "unanswered",
  description: "Unanswered Stack Overflow questions",
  domain: "stackoverflow.com",
  access: "read",
  browser: false,
  args: [{ name: "limit", type: "int", default: 10 }],
  func: async (_page, args): Promise<QuestionRow[]> => {
    const payload = await hostFetchJson(`https://api.stackexchange.com/2.3/questions/unanswered?order=desc&sort=votes&site=stackoverflow&pagesize=${args.limit}`)
    if (!isRecord(payload)) throw new CommandExecutionError("stackoverflow.unanswered: unexpected response")
    const items = payload.items
    const rows = questionRows(items, "stackoverflow.unanswered")
    return rows.slice(0, Number(args.limit))
  },
})

export const bounties = defineCommand({
  site: "stackoverflow",
  name: "bounties",
  description: "Featured (bounty) Stack Overflow questions",
  domain: "stackoverflow.com",
  access: "read",
  browser: false,
  args: [{ name: "limit", type: "int", default: 10 }],
  func: async (_page, args): Promise<QuestionRow[]> => {
    const payload = await hostFetchJson(`https://api.stackexchange.com/2.3/questions/featured?order=desc&sort=activity&site=stackoverflow&pagesize=${args.limit}`)
    if (!isRecord(payload)) throw new CommandExecutionError("stackoverflow.bounties: unexpected response")
    const items = payload.items
    const rows = questionRows(items, "stackoverflow.bounties")
    return rows.slice(0, Number(args.limit))
  },
})

export const tag = defineCommand({
  site: "stackoverflow",
  name: "tag",
  description: "Questions for a Stack Overflow tag",
  domain: "stackoverflow.com",
  access: "read",
  browser: false,
  args: [
    { name: "tag", required: true, help: "e.g. typescript, rust" },
    { name: "limit", type: "int", default: 10 },
  ],
  func: async (_page, args): Promise<QuestionRow[]> => {
    const payload = await hostFetchJson(`https://api.stackexchange.com/2.3/questions?order=desc&sort=activity&tagged=${args.tag}&site=stackoverflow&pagesize=${args.limit}`)
    if (!isRecord(payload)) throw new CommandExecutionError("stackoverflow.tag: unexpected response")
    const items = payload.items
    const rows = questionRows(items, "stackoverflow.tag")
    return rows.slice(0, Number(args.limit))
  },
})

export const read = defineCommand({
  site: "stackoverflow",
  name: "read",
  description: "Read a Stack Overflow question body + top answers",
  domain: "stackoverflow.com",
  access: "read",
  browser: false,
  args: [
    { name: "id", required: true, help: "Question ID (numeric)" },
    { name: "answers", type: "int", default: 3, help: "Top answers to include" },
  ],
  func: async (_page, args): Promise<StackoverflowReadRow[]> => {
    const id = String(args.id ?? "").trim()
    if (!/^\d+$/.test(id)) throw new ArgumentError("stackoverflow.read: id must be numeric")
    const answerLimit = Math.min(Math.max(Number(args.answers) || 3, 1), 10)
    const qUrl = `https://api.stackexchange.com/2.3/questions/${id}?order=desc&sort=activity&site=stackoverflow&filter=withbody`
    const aUrl = `https://api.stackexchange.com/2.3/questions/${id}/answers?order=desc&sort=votes&site=stackoverflow&filter=withbody&pagesize=${answerLimit}`
    const [qData, aData] = await Promise.all([
      fetch(qUrl).then((r) => r.json()) as Promise<{ items?: Array<Record<string, unknown>> }>,
      fetch(aUrl).then((r) => r.json()) as Promise<{ items?: Array<Record<string, unknown>> }>,
    ])
    const q = qData.items?.[0]
    if (!q) throw new EmptyResultError("stackoverflow", `stackoverflow.read: question ${id} not found`)
    const strip = (html: unknown) =>
      String(html ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1500)
    const rows: StackoverflowReadRow[] = [
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
    return rows as StackoverflowReadRow[]
  },
})

export const user = defineCommand({
  site: "stackoverflow",
  name: "user",
  description: "Stack Overflow user profile by id",
  domain: "stackoverflow.com",
  access: "read",
  browser: false,
  args: [{ name: "id", required: true, help: "User ID" }],
  func: async (_page, args): Promise<StackoverflowUserRow> => {
    const id = String(args.id ?? "").trim()
    if (!/^\d+$/.test(id)) throw new ArgumentError("stackoverflow.user: id must be numeric")
    const data = (await fetch(
      `https://api.stackexchange.com/2.3/users/${id}?site=stackoverflow`,
    ).then((r) => r.json())) as { items?: Array<Record<string, unknown>> }
    const u = data.items?.[0]
    if (!u) throw new EmptyResultError("stackoverflow", `stackoverflow.user: ${id} not found`)
    return {
      id: u.user_id,
      name: u.display_name,
      reputation: u.reputation,
      location: u.location || "",
      url: u.link,
    }
  },
})
