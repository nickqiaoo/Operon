export const GUIDE = `# Wikipedia guide

## Which function for which task
- Full plain-text extract of a Wikipedia article → \`wikipedia.page()\`.
- Get a random Wikipedia article → \`wikipedia.random()\`.
- Search Wikipedia articles → \`wikipedia.search()\`.
- Get Wikipedia article summary → \`wikipedia.summary()\`.
- Most-read Wikipedia articles (yesterday UTC) → \`wikipedia.trending()\`.

## Inputs
- search takes query; summary/page take an article title, not a URL.
- lang selects a Wikipedia language subdomain and defaults to en.
- page accepts paragraphs: 0 for the full extract or a positive cap.

## Needs
Uses public Wikipedia APIs; Chrome is not needed.

## Pitfalls
- summary/random extract is capped at 300 characters.
- search snippets are stripped of HTML and capped at 120 characters.
- page returns plain text and follows article redirects.
- trending uses yesterday in UTC; random is intentionally nondeterministic.

## Recipes
\`\`\`js
const matches = await siteAdapters.wikipedia.search({ query: "TypeScript", lang: "en", limit: 5 });
const summary = await siteAdapters.wikipedia.summary({ title: matches[0].title });
\`\`\`

\`\`\`js
const article = await siteAdapters.wikipedia.page({ title: "TypeScript", paragraphs: 2 });
const popular = await siteAdapters.wikipedia.trending({ lang: "en", limit: 5 });
\`\`\`

Use siteAdapters.help("wikipedia.page") for exact argument defaults.
`
