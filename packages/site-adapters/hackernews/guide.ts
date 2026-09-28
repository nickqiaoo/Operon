export const GUIDE = `# Hacker News guide

## Which function for which task
- Hacker News Ask HN posts → \`hackernews.ask()\`.
- Hacker News best stories → \`hackernews.best()\`.
- Hacker News jobs → \`hackernews.jobs()\`.
- Hacker News newest stories → \`hackernews.newest()\`.
- Search Hacker News stories → \`hackernews.search()\`.
- Hacker News Show HN posts → \`hackernews.show()\`.
- Hacker News top stories → \`hackernews.top()\`.
- Hacker News user profile → \`hackernews.user()\`.

## Inputs
- Use top/newest/best/ask/show/jobs for distinct story lists.
- search searches stories through Algolia; sort is relevance or date.
- user takes an HN username such as pg and returns a one-row array.

## Needs
Uses public Firebase and Algolia APIs; Chrome is not needed.

## Pitfalls
- Lists request at most 50 candidate stories, then skip deleted/dead items.
- Individual item fetch failures are skipped; a list may contain fewer than limit.
- Jobs and Ask HN posts may have no external url or comments count.

## Recipes
\`\`\`js
const stories = await siteAdapters.hackernews.top({ limit: 5 });
const profile = await siteAdapters.hackernews.user({ username: stories[0].author });
\`\`\`

\`\`\`js
const results = await siteAdapters.hackernews.search({ query: "TypeScript", sort: "date", limit: 5 });
const jobs = await siteAdapters.hackernews.jobs({ limit: 5 });
\`\`\`

Use siteAdapters.help("hackernews.ask") for exact argument defaults.
`
