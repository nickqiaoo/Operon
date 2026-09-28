export const GUIDE = `# Stack Overflow guide

## Which function for which task
- Featured (bounty) Stack Overflow questions → \`stackoverflow.bounties()\`.
- Hot Stack Overflow questions → \`stackoverflow.hot()\`.
- Read a Stack Overflow question body + top answers → \`stackoverflow.read()\`.
- Search Stack Overflow questions → \`stackoverflow.search()\`.
- Questions for a Stack Overflow tag → \`stackoverflow.tag()\`.
- Unanswered Stack Overflow questions → \`stackoverflow.unanswered()\`.
- Stack Overflow user profile by id → \`stackoverflow.user()\`.

## Inputs
- read and user take numeric ids, not full URLs.
- Question ids come from search/hot/unanswered/bounties/tag results.
- tag takes a tag slug; read includes the question and top answers.

## Needs
Uses public Stack Exchange API 2.3; Chrome is not needed.

## Pitfalls
- read strips HTML, normalizes whitespace and truncates bodies to 1500 characters.
- read caps the requested answer count to 1–10.
- Titles remain API text; tags is a comma-separated string, not an array.

## Recipes
\`\`\`js
const questions = await siteAdapters.stackoverflow.search({ query: "TypeScript", limit: 5 });
const detail = await siteAdapters.stackoverflow.read({ id: String(questions[0].id), answers: 3 });
\`\`\`

\`\`\`js
const questions = await siteAdapters.stackoverflow.tag({ tag: "typescript", limit: 5 });
const profile = await siteAdapters.stackoverflow.user({ id: "22656" });
\`\`\`

Use siteAdapters.help("stackoverflow.bounties") for exact argument defaults.
`
