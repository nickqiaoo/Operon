export const GUIDE = `# V2EX guide

## Which function for which task
- V2EX hot topics → \`v2ex.hot()\`.
- V2EX latest topics → \`v2ex.latest()\`.
- V2EX user profile → \`v2ex.member()\`.
- V2EX topics in a node → \`v2ex.node()\`.
- V2EX topic reply list → \`v2ex.replies()\`.
- V2EX topic detail with replies → \`v2ex.topic()\`.
- V2EX topics posted by a user → \`v2ex.user()\`.

## Inputs
- Topic id is the numeric id returned by hot/latest; pass the id, not a URL.
- member/user take a username; node takes the node slug, such as python.
- topic returns a one-row array; call replies separately for reply bodies.

## Needs
Uses public JSON APIs on www.v2ex.com; Chrome is not needed.

## Pitfalls
- The API returns a bounded page; limit only truncates that page.
- topic includes a reply count, not the reply list.
- Keep rank, floor and Unix created timestamps in their original form.

## Recipes
\`\`\`js
const topics = await siteAdapters.v2ex.hot({ limit: 5 });
const detail = await siteAdapters.v2ex.topic({ id: String(topics[0].id) });
const replies = await siteAdapters.v2ex.replies({ id: String(topics[0].id), limit: 10 });
\`\`\`

\`\`\`js
const profile = await siteAdapters.v2ex.member({ username: "Livid" });
const posts = await siteAdapters.v2ex.user({ username: "Livid", limit: 5 });
\`\`\`

Use siteAdapters.help("v2ex.hot") for exact argument defaults.
`
