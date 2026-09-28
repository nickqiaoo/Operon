export const GUIDE = `# Reddit guide

## Which function for which task
- Reddit Frontpage / r/all → \`reddit.frontpage()\`.
- Reddit personalized home feed (requires login) → \`reddit.home()\`.
- Reddit hot posts → \`reddit.hot()\`.
- Reddit Popular posts (/r/popular) → \`reddit.popular()\`.
- Browse your saved Reddit posts → \`reddit.saved()\`.
- Search Reddit Posts → \`reddit.search()\`.
- Get posts from a specific Subreddit → \`reddit.subreddit()\`.
- Show metadata for a Reddit subreddit → \`reddit.subredditInfo()\`.
- List subreddits you are subscribed to → \`reddit.subscribed()\`.
- Browse your upvoted Reddit posts → \`reddit.upvoted()\`.
- View a Reddit user profile → \`reddit.user()\`.
- Comments by a Reddit user → \`reddit.userComments()\`.
- Posts submitted by a Reddit user → \`reddit.userPosts()\`.
- Show the currently logged-in Reddit user → \`reddit.whoami()\`.

## Inputs
- subreddit/subredditInfo accept a subreddit name; a leading r/ is removed.
- user/userPosts/userComments take a username; a leading u/ is removed.
- search accepts a query and optional subreddit; sort/time affect the listing.

## Needs
Pass browser: globalThis.chrome. Account feeds require login on www.reddit.com.

## Pitfalls
- Most listings use one JSON page; limit does not fetch more pages.
- saved/upvoted/subscribed/whoami need the signed-in account.
- subscribed paginates and caps the total at 500.
- user returns field/value rows; whoami returns an object.
- Posts retain selftext, preview_image_url and gallery_urls; comments are truncated to 200 characters.

## Recipes
\`\`\`js
const browser = globalThis.chrome;
const posts = await siteAdapters.reddit.subreddit({ name: "programming", sort: "top", time: "week", limit: 5, browser });
const author = await siteAdapters.reddit.user({ username: posts[0].author, browser });
\`\`\`

\`\`\`js
const browser = globalThis.chrome;
const me = await siteAdapters.reddit.whoami({ browser });
const saved = await siteAdapters.reddit.saved({ limit: 5, browser });
\`\`\`

Use siteAdapters.help("reddit.frontpage") for exact argument defaults.
`
