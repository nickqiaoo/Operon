export const GUIDE = `# Bilibili guide

## Which function for which task
- Get Bilibili user dynamic feed (following timeline) → \`bilibili.dynamic()\`.
- Feed timeline. Without a uid it shows your following timeline; with one, that user's posts → \`bilibili.feed()\`.
- Who a Bilibili user follows → \`bilibili.following()\`.
- Your watch history → \`bilibili.history()\`.
- Bilibili popular videos → \`bilibili.hot()\`.
- My Bilibili profile info → \`bilibili.me()\`.
- Get Bilibili video ranking board → \`bilibili.ranking()\`.
- Search Bilibili videos or users → \`bilibili.search()\`.
- Videos uploaded by a given user → \`bilibili.userVideos()\`.
- Get Bilibili video metadata (title, author, stats) → \`bilibili.video()\`.

## Inputs
- video accepts a BV id, a full video URL or a b23.tv short link.
- User inputs accept numeric UID or a name resolved through user search.
- following defaults to the signed-in account; feed without uid reads the following timeline.

## Needs
Pass browser: globalThis.chrome with login on www.bilibili.com.

## Pitfalls
- history and personal feeds require login.
- Counts and output fields differ by function; keep the returned fields unchanged.
- feed can fetch several pages; pages defaults to one.
- Following may return a placeholder row describing an empty page.
- Video detail returns numeric duration and the canonical video URL.

## Recipes
\`\`\`js
const browser = globalThis.chrome;
const videos = await siteAdapters.bilibili.hot({ limit: 5, browser });
const detail = await siteAdapters.bilibili.video({ bvid: videos[0].bvid, browser });
\`\`\`

\`\`\`js
const browser = globalThis.chrome;
const uploads = await siteAdapters.bilibili.userVideos({ uid: "<UID>", limit: 5, browser });
const feed = await siteAdapters.bilibili.feed({ limit: 5, pages: 1, browser });
\`\`\`

Use siteAdapters.help("bilibili.dynamic") for exact argument defaults.
`
