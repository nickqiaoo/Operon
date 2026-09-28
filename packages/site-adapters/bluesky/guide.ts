export const GUIDE = `# Bluesky guide

## Which function for which task
- Author feed (recent posts) → \`bluesky.feed()\`.
- List Bluesky followers → \`bluesky.followers()\`.
- List accounts a Bluesky actor follows → \`bluesky.following()\`.
- Get Bluesky actor profile → \`bluesky.profile()\`.
- Search Bluesky users → \`bluesky.search()\`.
- Fetch a Bluesky post thread by AT URI or bsky.app URL → \`bluesky.thread()\`.
- Trending topics on Bluesky → \`bluesky.trending()\`.

## Inputs
- search finds actors, not posts.
- actor accepts a handle such as bsky.app or a DID.
- thread accepts an at:// post URI or an https://bsky.app/profile/handle/post/rkey URL.
- Use the uri returned by feed when possible.

## Needs
Uses public.api.bsky.app without Chrome or a login session.

## Pitfalls
- feed/thread text is truncated to 280 characters.
- thread walks the root and replies; it does not include the parent chain.
- feed/followers/following cap one request to 50; no cursor pagination.
- A bsky.app URL is resolved via resolveHandle before fetching the thread.

## Recipes
\`\`\`js
const profile = await siteAdapters.bluesky.profile({ actor: "bsky.app" });
const posts = await siteAdapters.bluesky.feed({ actor: profile.handle, limit: 5 });
const thread = await siteAdapters.bluesky.thread({ uri: posts[0].uri });
\`\`\`

\`\`\`js
const actors = await siteAdapters.bluesky.search({ query: "developer", limit: 5 });
const followers = await siteAdapters.bluesky.followers({ actor: actors[0].handle, limit: 5 });
\`\`\`

Use siteAdapters.help("bluesky.feed") for exact argument defaults.
`
