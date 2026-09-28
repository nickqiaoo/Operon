export const GUIDE = `# GitHub guide

## Which function for which task
- GitHub Trending repositories (public, no login) → \`github.trending()\`.

## Inputs
- trending takes since: daily, weekly or monthly.
- language is the GitHub language slug, such as python, rust or c++.
- Results include repo as owner/name and a full repository url.

## Needs
Fetches public github.com Trending HTML; Chrome is not needed.

## Pitfalls
- limit is capped at 25.
- language may be null when no language is displayed.
- starsSince is the period count for the selected since value.
- HTML parser drift and missing counts raise COMMAND_EXEC instead of fabricated numbers.

## Recipes
\`\`\`js
const repos = await siteAdapters.github.trending({ since: "daily", language: "typescript", limit: 5 });
nodeRepl.write(repos.map(repo => ({ repo: repo.repo, url: repo.url })));
\`\`\`

\`\`\`js
const weekly = await siteAdapters.github.trending({ since: "weekly", language: "rust", limit: 5 });
nodeRepl.write(weekly.map(repo => ({ repo: repo.repo, gained: repo.starsSince })));
\`\`\`

Use siteAdapters.help("github.trending") for exact argument defaults.
`
