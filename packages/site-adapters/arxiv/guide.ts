export const GUIDE = `# arXiv guide

## Which function for which task
- List arXiv papers by author (newest first) → \`arxiv.author()\`.
- Get arXiv paper details by ID → \`arxiv.paper()\`.
- List recent arXiv submissions in a category → \`arxiv.recent()\`.
- Search arXiv papers → \`arxiv.search()\`.

## Inputs
- paper takes a bare arXiv id, such as 1706.03762.
- search prefixes the query with all:; author builds an au: query.
- recent takes a category such as cs.CL or cs.LG.

## Needs
Uses the public export.arxiv.org Atom API; Chrome is not needed.

## Pitfalls
- search allows limit 1–25; recent/author allow 1–50.
- authors and categories are comma-separated strings.
- paper returns one record including abstract/pdf; lists return compact rows.
- Parsed ids omit version suffixes; published/updated are dates.

## Recipes
\`\`\`js
const papers = await siteAdapters.arxiv.search({ query: "attention", limit: 5 });
const detail = await siteAdapters.arxiv.paper({ id: papers[0].id });
\`\`\`

\`\`\`js
const recent = await siteAdapters.arxiv.recent({ category: "cs.CL", limit: 5 });
const authorPapers = await siteAdapters.arxiv.author({ author: "Ashish Vaswani", limit: 5 });
\`\`\`

Use siteAdapters.help("arxiv.author") for exact argument defaults.
`
