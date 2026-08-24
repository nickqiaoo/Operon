---
name: operon-site-adapters
description: Deterministic web site commands (Bilibili, Zhihu, Reddit, Twitter, GitHub, YouTube, Wikipedia, arXiv, Stack Overflow, Bluesky, Product Hunt, HN, V2EX, …) through Chrome session or public APIs via node_repl. Prefer over generic browsing when a listed command matches.
---

<!-- OPERON_MANAGED_SITE_ADAPTERS_SKILL -->

# Operon Site Adapters

Index of **deterministic site commands** on top of Operon Chrome / Browser Use.
Prefer a listed command over multi-step click-and-scrape when the task matches.

Requires Chrome Use enabled (Settings › Chrome) for cookie-backed commands.
Public API commands work without a browser tab.

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

Always pass `browser: globalThis.chrome` into cookie commands.
Do **not** shell out to `opencli` or curl logged-in APIs from the host.

## Discover

```js
nodeRepl.write(JSON.stringify(siteAdapters.list(), null, 2));
nodeRepl.write(JSON.stringify(siteAdapters.search("github"), null, 2));
nodeRepl.write(siteAdapters.help("arxiv.search"));
```

## Invoke

```js
await siteAdapters.github.trending({ since: "weekly", language: "typescript" });
await siteAdapters.wikipedia.summary({ title: "Transformer (machine learning model)" });
await siteAdapters.youtube.search({ query: "agentic coding", browser: globalThis.chrome });
await siteAdapters.run("stackoverflow.hot", { limit: 10 });
```

## Command index (by site)

### International / public-friendly

| Site | Commands | Chrome |
|------|----------|--------|
| **github** | `trending` | no |
| **wikipedia** | `search` `summary` `page` `random` `trending` | no |
| **arxiv** | `search` `paper` `recent` `author` | no |
| **stackoverflow** | `search` `hot` `unanswered` `bounties` `tag` `read` `user` | no |
| **bluesky** | `trending` `search` `profile` `feed` `thread` `followers` `following` | no |
| **producthunt** | `posts` `today` `hot` | no |
| **hackernews** | `top` `newest` `best` `ask` `show` `jobs` `search` `user` | no |
| **youtube** | `search` `feed` `video` `comments` | **yes** |
| **twitter** | `trending` `profile` `timeline` `tweets` `search` `thread` | **yes** |
| **reddit** | `hot` `frontpage` `popular` `home` `subreddit` `search` `user` … | **yes** |

### CN / other

| Site | Highlights | Chrome |
|------|------------|--------|
| **bilibili** | hot ranking search video me history feed … | yes |
| **zhihu** | hot search question user recommend … | yes |
| **v2ex** | hot latest topic replies … | no |

Use `list()` / `search()` for full arg details. HN newest JS property is
`siteAdapters.hackernews.newest` (id `hackernews.new`).

Write actions (like/post/follow) are **not** ported.

## Fallbacks

| Intent | Skill |
|--------|-------|
| Listed command | this skill |
| Unknown site / free UI | `operon-chrome` |
| Mac desktop apps | `operon-computer-use` |
