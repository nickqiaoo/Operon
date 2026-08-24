import { defineCommand } from "../define.ts"

export const user = defineCommand({
  site: "hackernews",
  name: "user",
  description: "Hacker News user profile",
  domain: "news.ycombinator.com",
  access: "read",
  strategy: "public",
  browser: false,
  args: [{ name: "username", required: true, positional: true, help: "HN username" }],
  columns: ["username", "karma", "created", "about"],
  pipeline: [
    { fetch: { url: "https://hacker-news.firebaseio.com/v0/user/${{ args.username }}.json" } },
    {
      map: {
        username: "${{ item.id }}",
        karma: "${{ item.karma }}",
        created: "${{ item.created ? new Date(item.created * 1000).toISOString().slice(0, 10) : '' }}",
        about: "${{ item.about }}",
      },
    },
  ],
})
