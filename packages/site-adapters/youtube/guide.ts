

export const GUIDE = `# YouTube guide

## Which function for which task
- Read rendered YouTube video comments → \`youtube.comments()\`.
- YouTube homepage recommended videos → \`youtube.feed()\`.
- Search YouTube videos → \`youtube.search()\`.
- Get YouTube video metadata → \`youtube.video()\`.

## Inputs
- video/comments accept a video id, watch URL, youtu.be URL, shorts/embed/live URL.
- search takes query and optional type/upload/sort filters.
- feed reads the homepage recommendations in the current Chrome session.

## Needs
Pass browser: globalThis.chrome. Personalized feed uses the login on www.youtube.com.

## Pitfalls
- views/likes/duration/published are display strings, not normalized numbers or dates.
- Search filter precedence is type, then upload, then sort; filters are not combined.
- video description is capped at 500 characters.
- comments reads only rendered comments; availability depends on page loading.
- Empty lists do not prove the video has no comments.

## Recipes
\`\`\`js
const browser = globalThis.chrome;
const results = await siteAdapters.youtube.search({ query: "TypeScript", limit: 5, browser });
const video = await siteAdapters.youtube.video({ url: results[0].url, browser });
\`\`\`

\`\`\`js
const browser = globalThis.chrome;
const comments = await siteAdapters.youtube.comments({ url: "https://youtu.be/dQw4w9WgXcQ", limit: 10, browser });
const feed = await siteAdapters.youtube.feed({ limit: 5, browser });
\`\`\`

Use siteAdapters.help("youtube.comments") for exact argument defaults.
`
