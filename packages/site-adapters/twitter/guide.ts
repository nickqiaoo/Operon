export const GUIDE = `# Twitter / X guide

## Which function for which task
- Fetch a Twitter/X user profile → \`twitter.profile()\`.
- Search Twitter/X posts → \`twitter.search()\`.
- Fetch a tweet thread by status URL or id → \`twitter.thread()\`.
- Home timeline (for-you or following) → \`twitter.timeline()\`.
- Twitter/X trending topics → \`twitter.trending()\`.
- Fetch recent tweets from a user → \`twitter.tweets()\`.

## Inputs
- username is a screen name; tweets removes a leading @.
- profile can detect the signed-in user when username is omitted.
- thread accepts a status URL or numeric status id; preserve large ids as strings.
- timeline type is for-you or following; search product is Latest or Top.

## Needs
Pass browser: globalThis.chrome with login on x.com (ct0 cookie required).

## Pitfalls
- Timeline/search pagination is bounded to five requests.
- Tweet text and engagement fields come from GraphQL data; views are parsed as numbers.
- thread reads rendered articles; missing content returns a focal status shell.
- thread likes/retweets are zero placeholders, not measured engagement.
- Query ids are refreshed from upstream with pinned fallbacks.

## Recipes
\`\`\`js
const browser = globalThis.chrome;
const tweets = await siteAdapters.twitter.search({ query: "TypeScript", product: "Latest", limit: 5, browser });
const thread = await siteAdapters.twitter.thread({ url: tweets[0].url, browser });
\`\`\`

\`\`\`js
const browser = globalThis.chrome;
const profile = await siteAdapters.twitter.profile({ username: "sama", browser });
const tweets = await siteAdapters.twitter.tweets({ username: profile.screen_name, limit: 5, browser });
\`\`\`

Use siteAdapters.help("twitter.profile") for exact argument defaults.
`
