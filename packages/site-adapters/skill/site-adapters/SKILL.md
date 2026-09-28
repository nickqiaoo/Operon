---
name: operon-site-adapters
description: Ready-made functions for reading popular sites through the user's logged-in Chrome or public APIs via node_repl — Xiaohongshu (小红书) note text and video subtitles/transcripts (no Chrome needed), search, comments, media download, Bilibili, Zhihu, Twitter/X, Reddit, YouTube, GitHub, Wikipedia, arXiv, Stack Overflow, Bluesky, Product Hunt, HN, V2EX. Prefer over generic browsing when a function below fits the task.
---

<!-- OPERON_MANAGED_SITE_ADAPTERS_SKILL -->

# Operon Site Adapters

Functions that do one site task end to end: open the page in the user's Chrome
session (so logged-in content works), extract structured data, return plain
objects. Use them instead of clicking through a site with `operon-chrome` when
one fits: they are faster, deterministic, and already handle the site's quirks
(signed URLs, lazy loading, risk-control pacing).

Functions marked **Chrome** need Chrome Use enabled (Settings › Chrome) and the
user logged in to that site in Chrome. The rest call public APIs.

## Connect (once per JS session)

Run through the `node_repl` MCP `js` tool only.

```js
if (globalThis.agent?.browsers == null) {
  const clientPath = nodeRepl.env?.OPERON_BROWSER_CLIENT_PATH;
  if (typeof clientPath !== "string" || clientPath.length === 0) {
    throw new Error("Operon Browser client is unavailable");
  }
  const { setupBrowserRuntime } = await import(clientPath);
  await setupBrowserRuntime({ globals: globalThis });
}

if (globalThis.chrome == null) {
  try {
    globalThis.chrome = await agent.browsers.get("chrome");
  } catch (e) {
    globalThis.chrome = null;
  }
}

const adaptersPath = nodeRepl.env?.OPERON_SITE_ADAPTERS_PATH;
if (typeof adaptersPath !== "string" || adaptersPath.length === 0) {
  throw new Error("Operon site adapters are unavailable");
}
if (globalThis.siteAdapters == null) {
  globalThis.siteAdapters = await import(adaptersPath);
}
```

Every Chrome function takes `browser: globalThis.chrome`. Do **not** shell out
to `opencli` or curl logged-in APIs from the host.

## Before using a site

Read its guide first for input formats, which function fits the task, and pitfalls:

```js
nodeRepl.write(siteAdapters.guide("xiaohongshu"));
```

## What to call

| Task | Call | Chrome |
|------|------|--------|
| Xiaohongshu captions / video transcripts | `xiaohongshu.getNote({url})` | no (optional fallback) |
| Xiaohongshu search / comments / author / feed | `xiaohongshu.search({query})` `xiaohongshu.getComments({url})` `xiaohongshu.userNotes({user})` `xiaohongshu.feed()` | yes |
| Xiaohongshu save requested media | `xiaohongshu.downloadMedia({note})` | no |
| Bilibili hot / ranking | `bilibili.hot({limit})` `bilibili.ranking({limit})` | yes |
| Bilibili search, a video, an uploader's videos | `bilibili.search({query})` `bilibili.video({bvid})` `bilibili.userVideos({uid})` | yes |
| Bilibili my history / following feed | `bilibili.history()` `bilibili.dynamic()` `bilibili.feed()` `bilibili.following()` `bilibili.me()` | yes |
| Zhihu hot list / search / recommend | `zhihu.hot()` `zhihu.search({query})` `zhihu.recommend()` | yes |
| Zhihu question with answers, one answer, its comments | `zhihu.question({id})` `zhihu.answerDetail({id})` `zhihu.answerComments({id})` | yes |
| Zhihu user profile and content | `zhihu.user({user})` `zhihu.userAnswers({user})` `zhihu.userArticles({user})` `zhihu.pins({user})` `zhihu.followers({user})` `zhihu.following({user})` `zhihu.collections()` | yes |
| Twitter/X search, a user's tweets, a thread | `twitter.search({query})` `twitter.tweets({username})` `twitter.thread({url})` | yes |
| Twitter/X trends, profile, home timeline | `twitter.trending()` `twitter.profile({username})` `twitter.timeline()` | yes |
| Reddit subreddit / search / a user | `reddit.subreddit({name})` `reddit.search({query})` `reddit.userPosts({username})` `reddit.userComments({username})` `reddit.subredditInfo({name})` | yes |
| Reddit feeds and my account | `reddit.hot()` `reddit.frontpage()` `reddit.popular()` `reddit.home()` `reddit.saved()` `reddit.upvoted()` `reddit.subscribed()` `reddit.whoami()` | yes |
| YouTube search, a video, its comments, my feed | `youtube.search({query})` `youtube.video({url})` `youtube.comments({url})` `youtube.feed()` | yes |
| GitHub trending repos | `github.trending({since, language})` | no |
| Wikipedia lookup | `wikipedia.summary({title})` `wikipedia.page({title})` `wikipedia.search({query})` | no |
| arXiv papers | `arxiv.search({query})` `arxiv.paper({id})` `arxiv.recent({category})` `arxiv.author({author})` | no |
| Stack Overflow | `stackoverflow.search({query})` `stackoverflow.read({id})` `stackoverflow.tag({tag})` `stackoverflow.hot()` | no |
| Bluesky | `bluesky.search({query})` `bluesky.profile({actor})` `bluesky.feed({actor})` `bluesky.thread({uri})` | no |
| Hacker News | `hackernews.top()` `hackernews.newest()` `hackernews.search({query})` `hackernews.user({username})` | no |
| V2EX | `v2ex.hot()` `v2ex.latest()` `v2ex.topic({id})` `v2ex.replies({id})` | no |
| Product Hunt | `producthunt.today()` `producthunt.hot()` `producthunt.posts()` | no |

Most list functions take `limit`. For a function's exact arguments and
defaults, ask instead of guessing:

```js
nodeRepl.write(siteAdapters.help("zhihu.question"));
nodeRepl.write(JSON.stringify(siteAdapters.search("小红书"), null, 2));
nodeRepl.write(JSON.stringify(siteAdapters.list(), null, 2));
```

## Errors

Adapter errors carry a `code`:

| code | Meaning | Do |
|------|---------|----|
| `AUTH_REQUIRED` | Not logged in to the site in Chrome | Ask the user to log in, then retry |
| `SECURITY_BLOCK` | The site's risk control kicked in | Stop; tell the user to wait. Retrying makes it worse |
| `EMPTY_RESULT` | Legitimately nothing there | Report it; not a failure |
| `ARGUMENT` | Bad input (e.g. a note URL without `xsec_token`) | Fix the input |
| `COMMAND_EXEC` | Request or payload failed | Report the failure; consult the site guide |
| `TIMEOUT` | The site did not finish in time | Report it; consult the site guide |

Write actions (like, follow, post, delete) are not available.

## Fallbacks

| Intent | Skill |
|--------|-------|
| A function above fits | this skill |
| Unknown site / free-form UI work | `operon-chrome` |
| Mac desktop apps | `operon-computer-use` |
