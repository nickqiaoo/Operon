import { defineCommand } from "../define.ts"
import { hostFetchJson } from "../runtime/page.ts"
import { requireRows } from "../runtime/values.ts"

export interface HackernewsUserRow {
  username: string | undefined
  karma: number | undefined
  created: string | undefined
  about: string | undefined
}

export const user = defineCommand({
  site: "hackernews",
  name: "user",
  description: "Hacker News user profile",
  domain: "news.ycombinator.com",
  access: "read",
  browser: false,
  args: [{ name: "username", required: true, help: "HN username" }],
  func: async (_page, args): Promise<HackernewsUserRow[]> => {
    const payload = await hostFetchJson(`https://hacker-news.firebaseio.com/v0/user/${args.username}.json`)
    const items = requireRows(payload, "hackernews.user").map((item, index) => {
      return {
        username: item.id as string | undefined,
        karma: item.karma as number | undefined,
        created: item.created ? new Date(Number(item.created) * 1000).toISOString().slice(0, 10) : '' as string | undefined,
        about: item.about as string | undefined,
      }
    })
    return items
  },
})
