export const GUIDE = `# Zhihu guide

## Which function for which task
- Comments on a Zhihu answer → \`zhihu.answerComments()\`.
- Full text of a single Zhihu answer → \`zhihu.answerDetail()\`.
- Zhihu collections, for the signed-in user or a named one → \`zhihu.collections()\`.
- A Zhihu user's followers → \`zhihu.followers()\`.
- Who a Zhihu user follows → \`zhihu.following()\`.
- Zhihu hot list → \`zhihu.hot()\`.
- Pins posted by a Zhihu user → \`zhihu.pins()\`.
- Zhihu question with answers → \`zhihu.question()\`.
- Zhihu home feed → \`zhihu.recommend()\`.
- Zhihu search → \`zhihu.search()\`.
- Zhihu user profile → \`zhihu.user()\`.
- Answers written by a Zhihu user → \`zhihu.userAnswers()\`.
- Articles and columns by a Zhihu user → \`zhihu.userArticles()\`.

## Inputs
- User inputs accept a url_token, user:token or an HTTPS /people/token URL.
- question takes a numeric question id; answerDetail/answerComments accept an answer id or answer URL.
- Question and answer ids may be large; keep string ids without number conversion.

## Needs
Pass browser: globalThis.chrome with the user logged in to www.zhihu.com.

## Pitfalls
- question content is capped at 500 characters; search excerpts at 200.
- answerDetail reads longer content; maxContent: 0 keeps it full.
- collections can detect the signed-in user when user is omitted.
- List endpoints follow paging.next up to the requested limit.
- API authentication failures raise AUTH_REQUIRED.

## Recipes
\`\`\`js
const browser = globalThis.chrome;
const answers = await siteAdapters.zhihu.question({ id: "19551137", limit: 5, browser });
const detail = await siteAdapters.zhihu.answerDetail({ id: answers[0].id, browser });
\`\`\`

\`\`\`js
const browser = globalThis.chrome;
const profile = await siteAdapters.zhihu.user({ user: "<url_token>", browser });
const answers = await siteAdapters.zhihu.userAnswers({ user: profile.url_token, limit: 5, browser });
\`\`\`

Use siteAdapters.help("zhihu.answerComments") for exact argument defaults.
`
