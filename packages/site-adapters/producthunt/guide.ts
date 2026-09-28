export const GUIDE = `# Product Hunt guide

## Which function for which task
- Recent Product Hunt feed (alias of posts) → \`producthunt.hot()\`.
- Latest Product Hunt launches (Atom feed) → \`producthunt.posts()\`.
- Today's Product Hunt launches (from feed latest date) → \`producthunt.today()\`.

## Inputs
- posts takes an optional category slug, such as ai-agents or developer-tools.
- today selects entries on the newest date present in the Atom feed.
- hot reads the same recent feed as posts, without a category.

## Needs
Fetches the public Product Hunt Atom feed; Chrome is not needed.

## Pitfalls
- today means the feed latest date, not the host clock date.
- HTTP feed failures return an empty array.
- This feed has no votes or ranking by popularity.
- posts/hot preserve feed rank and date; today re-ranks and omits date.

## Recipes
\`\`\`js
const launches = await siteAdapters.producthunt.posts({ category: "developer-tools", limit: 5 });
nodeRepl.write(launches.map(item => ({ name: item.name, url: item.url })));
\`\`\`

\`\`\`js
const today = await siteAdapters.producthunt.today({ limit: 5 });
const recent = await siteAdapters.producthunt.hot({ limit: 10 });
\`\`\`

Use siteAdapters.help("producthunt.hot") for exact argument defaults.
`
