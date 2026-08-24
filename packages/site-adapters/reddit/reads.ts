/**
 * Reddit read surface — OpenCLI clis/reddit/* (cookie + .json endpoints).
 */

import { defineCommand } from "../define.ts"
import { POST_COLUMNS, POST_MAP, REDDIT_MEDIA_HELPERS } from "./shared.ts"

function listingPipeline(opts: {
  name: string
  description: string
  args?: Array<{ name: string; type?: "string" | "int"; required?: boolean; positional?: boolean; default?: unknown; help?: string; choices?: string[] }>
  navigate?: string
  evaluateBody: string
}) {
  return defineCommand({
    site: "reddit",
    name: opts.name,
    description: opts.description,
    domain: "www.reddit.com",
    access: "read",
    strategy: "cookie",
    browser: true,
    args: opts.args ?? [{ name: "limit", type: "int", default: 20 }],
    columns: [...POST_COLUMNS],
    pipeline: [
      ...(opts.navigate ? [{ navigate: opts.navigate } as const] : [{ navigate: "https://www.reddit.com" } as const]),
      { evaluate: opts.evaluateBody },
      { map: { ...POST_MAP } },
      { limit: "${{ args.limit }}" },
    ],
  })
}

const mapPostFromChild = `
  return (d?.data?.children || []).map(c => ({
    id: c.data.id,
    title: c.data.title,
    subreddit: c.data.subreddit_name_prefixed,
    score: c.data.score,
    comments: c.data.num_comments,
    author: c.data.author,
    url: 'https://www.reddit.com' + c.data.permalink,
    created_utc: c.data.created_utc,
    selftext: c.data.selftext || '',
    ...extractRedditMedia(c.data),
  }));
`

export const hot = defineCommand({
  site: "reddit",
  name: "hot",
  description: "Reddit hot posts",
  domain: "www.reddit.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "subreddit", default: "", help: "Subreddit name (e.g. programming). Empty for frontpage hot" },
    { name: "limit", type: "int", default: 20, help: "Number of posts" },
  ],
  columns: [...POST_COLUMNS],
  pipeline: [
    { navigate: "https://www.reddit.com" },
    {
      evaluate: `(async () => {
  ${REDDIT_MEDIA_HELPERS}
  const sub = \${{ args.subreddit | json }};
  const path = sub ? '/r/' + sub + '/hot.json' : '/hot.json';
  const limit = \${{ args.limit }};
  const res = await fetch(path + '?limit=' + limit + '&raw_json=1', { credentials: 'include' });
  const d = await res.json();
  ${mapPostFromChild}
})()`,
    },
    { map: { ...POST_MAP } },
    { limit: "${{ args.limit }}" },
  ],
})

export const frontpage = listingPipeline({
  name: "frontpage",
  description: "Reddit Frontpage / r/all",
  args: [{ name: "limit", type: "int", default: 15 }],
  evaluateBody: `(async () => {
  ${REDDIT_MEDIA_HELPERS}
  const res = await fetch('/r/all.json?limit=\${{ args.limit }}&raw_json=1', { credentials: 'include' });
  const d = await res.json();
  ${mapPostFromChild}
})()`,
})

export const popular = listingPipeline({
  name: "popular",
  description: "Reddit Popular posts (/r/popular)",
  evaluateBody: `(async () => {
  ${REDDIT_MEDIA_HELPERS}
  const limit = \${{ args.limit }};
  const res = await fetch('/r/popular.json?limit=' + limit + '&raw_json=1', { credentials: 'include' });
  const d = await res.json();
  ${mapPostFromChild}
})()`,
})

export const subreddit = listingPipeline({
  name: "subreddit",
  description: "Get posts from a specific Subreddit",
  args: [
    { name: "name", type: "string", required: true, positional: true, help: "Subreddit name (no r/ prefix)" },
    {
      name: "sort",
      type: "string",
      default: "hot",
      help: "hot, new, top, rising, controversial",
      choices: ["hot", "new", "top", "rising", "controversial"],
    },
    {
      name: "time",
      type: "string",
      default: "all",
      help: "Time filter for top/controversial",
      choices: ["hour", "day", "week", "month", "year", "all"],
    },
    { name: "limit", type: "int", default: 15 },
  ],
  evaluateBody: `(async () => {
  ${REDDIT_MEDIA_HELPERS}
  let name = \${{ args.name | json }};
  if (name.startsWith('r/')) name = name.slice(2);
  const sort = \${{ args.sort | json }};
  const time = \${{ args.time | json }};
  const limit = \${{ args.limit }};
  let path = '/r/' + name + '/' + sort + '.json?limit=' + limit + '&raw_json=1';
  if (sort === 'top' || sort === 'controversial') path += '&t=' + time;
  const res = await fetch(path, { credentials: 'include' });
  const d = await res.json();
  ${mapPostFromChild}
})()`,
})

export const search = listingPipeline({
  name: "search",
  description: "Search Reddit Posts",
  args: [
    { name: "query", type: "string", required: true, positional: true, help: "Search query" },
    { name: "subreddit", type: "string", default: "", help: "Restrict to subreddit" },
    {
      name: "sort",
      type: "string",
      default: "relevance",
      choices: ["relevance", "hot", "top", "new", "comments"],
    },
    {
      name: "time",
      type: "string",
      default: "all",
      choices: ["hour", "day", "week", "month", "year", "all"],
    },
    { name: "limit", type: "int", default: 15 },
  ],
  evaluateBody: `(async () => {
  ${REDDIT_MEDIA_HELPERS}
  const q = encodeURIComponent(\${{ args.query | json }});
  const sub = \${{ args.subreddit | json }};
  const sort = \${{ args.sort | json }};
  const time = \${{ args.time | json }};
  const limit = \${{ args.limit }};
  const basePath = sub ? '/r/' + sub + '/search.json' : '/search.json';
  const params = 'q=' + q + '&sort=' + sort + '&t=' + time + '&limit=' + limit
    + '&restrict_sr=' + (sub ? 'on' : 'off') + '&raw_json=1';
  const res = await fetch(basePath + '?' + params, { credentials: 'include' });
  const d = await res.json();
  ${mapPostFromChild}
})()`,
})

export const userPosts = listingPipeline({
  name: "user-posts",
  description: "Posts submitted by a Reddit user",
  args: [
    { name: "username", type: "string", required: true, positional: true, help: "Username (no u/ prefix)" },
    { name: "limit", type: "int", default: 15 },
  ],
  evaluateBody: `(async () => {
  ${REDDIT_MEDIA_HELPERS}
  let name = \${{ args.username | json }};
  if (name.startsWith('u/')) name = name.slice(2);
  const limit = \${{ args.limit }};
  const res = await fetch('/user/' + name + '/submitted.json?limit=' + limit + '&raw_json=1', { credentials: 'include' });
  const d = await res.json();
  ${mapPostFromChild}
})()`,
})

export const userComments = defineCommand({
  site: "reddit",
  name: "user-comments",
  description: "Comments by a Reddit user",
  domain: "www.reddit.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "username", type: "string", required: true, positional: true },
    { name: "limit", type: "int", default: 15 },
  ],
  columns: ["rank", "id", "subreddit", "body", "score", "url"],
  pipeline: [
    { navigate: "https://www.reddit.com" },
    {
      evaluate: `(async () => {
  let name = \${{ args.username | json }};
  if (name.startsWith('u/')) name = name.slice(2);
  const limit = \${{ args.limit }};
  const res = await fetch('/user/' + name + '/comments.json?limit=' + limit + '&raw_json=1', { credentials: 'include' });
  const d = await res.json();
  return (d?.data?.children || []).map(c => ({
    id: c.data.id,
    subreddit: c.data.subreddit_name_prefixed,
    body: (c.data.body || '').slice(0, 200),
    score: c.data.score,
    url: 'https://www.reddit.com' + (c.data.permalink || ''),
  }));
})()`,
    },
    {
      map: {
        rank: "${{ index + 1 }}",
        id: "${{ item.id }}",
        subreddit: "${{ item.subreddit }}",
        body: "${{ item.body }}",
        score: "${{ item.score }}",
        url: "${{ item.url }}",
      },
    },
    { limit: "${{ args.limit }}" },
  ],
})

export const user = defineCommand({
  site: "reddit",
  name: "user",
  description: "View a Reddit user profile",
  domain: "www.reddit.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "username", type: "string", required: true, positional: true, help: "Username (no u/ prefix)" },
  ],
  columns: ["field", "value"],
  pipeline: [
    { navigate: "https://www.reddit.com" },
    {
      evaluate: `(async () => {
  let username = \${{ args.username | json }};
  const name = username.startsWith('u/') ? username.slice(2) : username;
  const res = await fetch('/user/' + name + '/about.json?raw_json=1', { credentials: 'include' });
  const d = await res.json();
  const u = d?.data || d || {};
  const created = u.created_utc ? new Date(u.created_utc * 1000).toISOString().split('T')[0] : '-';
  return [
    { k: 'Username', v: 'u/' + (u.name || name) },
    { k: 'Post Karma', v: String(u.link_karma || 0) },
    { k: 'Comment Karma', v: String(u.comment_karma || 0) },
    { k: 'Total Karma', v: String(u.total_karma || (u.link_karma||0) + (u.comment_karma||0)) },
    { k: 'Account Created', v: created },
    { k: 'Gold', v: u.is_gold ? 'Yes' : 'No' },
    { k: 'Verified', v: u.verified ? 'Yes' : 'No' },
  ];
})()`,
    },
    { map: { field: "${{ item.k }}", value: "${{ item.v }}" } },
  ],
})

export const whoami = defineCommand({
  site: "reddit",
  name: "whoami",
  description: "Show the currently logged-in Reddit user",
  domain: "www.reddit.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [],
  columns: ["username", "link_karma", "comment_karma", "created"],
  func: async (page) => {
    if (!page) throw new Error("reddit: browser required")
    await page.goto("https://www.reddit.com")
    const result = (await page.evaluate(`(async () => {
      try {
        const res = await fetch('/api/me.json?raw_json=1', { credentials: 'include' });
        if (res.status === 401 || res.status === 403) {
          return { kind: 'auth', detail: 'Reddit /api/me.json returned HTTP ' + res.status };
        }
        if (!res.ok) return { kind: 'http', httpStatus: res.status };
        const d = await res.json();
        const me = d?.data;
        if (!me?.name) return { kind: 'auth', detail: 'Not logged in to reddit.com' };
        return { kind: 'ok', identity: me };
      } catch (e) {
        return { kind: 'exception', detail: String(e && e.message || e) };
      }
    })()`)) as {
      kind: string
      detail?: string
      httpStatus?: number
      identity?: Record<string, unknown>
    }
    if (result?.kind === "auth") throw new Error(`reddit.whoami: ${result.detail}`)
    if (result?.kind !== "ok" || !result.identity) {
      throw new Error(`reddit.whoami failed: ${JSON.stringify(result)}`)
    }
    const u = result.identity
    return {
      username: u.name,
      link_karma: u.link_karma ?? 0,
      comment_karma: u.comment_karma ?? 0,
      created: u.created_utc
        ? new Date(Number(u.created_utc) * 1000).toISOString().slice(0, 10)
        : "",
    }
  },
})

export const home = defineCommand({
  site: "reddit",
  name: "home",
  description: "Reddit personalized home feed (requires login)",
  domain: "www.reddit.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: [...POST_COLUMNS],
  pipeline: [
    { navigate: "https://www.reddit.com" },
    {
      evaluate: `(async () => {
  ${REDDIT_MEDIA_HELPERS}
  const limit = \${{ args.limit }};
  const res = await fetch('/.json?limit=' + limit + '&raw_json=1', { credentials: 'include' });
  const d = await res.json();
  ${mapPostFromChild}
})()`,
    },
    { map: { ...POST_MAP } },
    { limit: "${{ args.limit }}" },
  ],
})

export const subredditInfo = defineCommand({
  site: "reddit",
  name: "subreddit-info",
  description: "Show metadata for a Reddit subreddit",
  domain: "www.reddit.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "name", type: "string", required: true, positional: true, help: "Subreddit name" },
  ],
  columns: ["name", "title", "subscribers", "active", "description", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("reddit: browser required")
    await page.goto("https://www.reddit.com")
    let sub = String(kwargs.name ?? "")
    if (sub.startsWith("r/")) sub = sub.slice(2)
    const result = (await page.evaluate(`(async () => {
      const sub = ${JSON.stringify(sub)};
      try {
        const res = await fetch('/r/' + sub + '/about.json?raw_json=1', { credentials: 'include' });
        if (!res.ok) return { kind: 'http', httpStatus: res.status };
        const j = await res.json();
        const info = j?.data;
        if (!info || !info.display_name) return { kind: 'missing' };
        return { kind: 'ok', info };
      } catch (e) {
        return { kind: 'exception', detail: String(e && e.message || e) };
      }
    })()`)) as { kind: string; info?: Record<string, unknown>; httpStatus?: number; detail?: string }
    if (result.kind !== "ok" || !result.info) {
      throw new Error(`reddit.subreddit-info: subreddit unavailable (${JSON.stringify(result)})`)
    }
    const info = result.info
    return {
      name: info.display_name_prefixed || `r/${info.display_name}`,
      title: info.title || "",
      subscribers: info.subscribers ?? 0,
      active: info.accounts_active ?? info.active_user_count ?? 0,
      description: String(info.public_description || "").slice(0, 300),
      url: `https://www.reddit.com/r/${info.display_name}`,
    }
  },
})

async function userListing(
  page: { goto: (u: string) => Promise<void>; evaluate: (s: string) => Promise<unknown> },
  path: "saved" | "upvoted",
  limit: number,
) {
  await page.goto("https://www.reddit.com")
  const result = (await page.evaluate(`(async () => {
    try {
      const meRes = await fetch('/api/me.json?raw_json=1', { credentials: 'include' });
      const me = await meRes.json();
      const username = me?.name || me?.data?.name;
      if (!username) return { error: 'Not logged in' };
      const limit = ${limit};
      const res = await fetch('/user/' + username + '/${path}.json?limit=' + limit + '&raw_json=1', {
        credentials: 'include'
      });
      const d = await res.json();
      return (d?.data?.children || []).map(c => ({
        title: c.data.title || c.data.body?.slice(0, 100) || '',
        subreddit: c.data.subreddit_name_prefixed || 'r/' + (c.data.subreddit || '?'),
        score: c.data.score || 0,
        comments: c.data.num_comments || 0,
        url: 'https://www.reddit.com' + (c.data.permalink || ''),
      }));
    } catch (e) {
      return { error: String(e) };
    }
  })()`)) as Array<Record<string, unknown>> | { error: string }
  if (result && !Array.isArray(result) && "error" in result) {
    throw new Error(`reddit.${path}: ${result.error}`)
  }
  return (result as Array<Record<string, unknown>>).slice(0, limit)
}

export const saved = defineCommand({
  site: "reddit",
  name: "saved",
  description: "Browse your saved Reddit posts",
  domain: "www.reddit.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [{ name: "limit", type: "int", default: 15 }],
  columns: ["title", "subreddit", "score", "comments", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("reddit: browser required")
    return userListing(page, "saved", Number(kwargs.limit) || 15)
  },
})

export const upvoted = defineCommand({
  site: "reddit",
  name: "upvoted",
  description: "Browse your upvoted Reddit posts",
  domain: "www.reddit.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [{ name: "limit", type: "int", default: 15 }],
  columns: ["title", "subreddit", "score", "comments", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("reddit: browser required")
    return userListing(page, "upvoted", Number(kwargs.limit) || 15)
  },
})

export const subscribed = defineCommand({
  site: "reddit",
  name: "subscribed",
  description: "List subreddits you are subscribed to",
  domain: "www.reddit.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [{ name: "limit", type: "int", default: 100, help: "Max subreddits (1-500)" }],
  columns: ["id", "subreddit", "title", "subscribers", "description", "url"],
  func: async (page, kwargs) => {
    if (!page) throw new Error("reddit: browser required")
    const limit = Math.min(Math.max(Number(kwargs.limit) || 100, 1), 500)
    await page.goto("https://www.reddit.com")
    const result = (await page.evaluate(`(async () => {
      try {
        const meRes = await fetch('/api/me.json?raw_json=1', { credentials: 'include' });
        const me = await meRes.json();
        if (!me?.data?.name && !me?.name) return { error: 'Not logged in' };
        const out = [];
        let after = null;
        const limit = ${limit};
        while (out.length < limit) {
          const url = '/subreddits/mine/subscriber.json?limit=100&raw_json=1' + (after ? '&after=' + after : '');
          const res = await fetch(url, { credentials: 'include' });
          const d = await res.json();
          const children = d?.data?.children || [];
          if (!children.length) break;
          for (const entry of children) {
            if (out.length >= limit) break;
            const data = entry.data || {};
            const displayName = data.display_name || '';
            const path = typeof data.url === 'string' && data.url.startsWith('/r/') ? data.url : '';
            out.push({
              id: data.name || '',
              subreddit: data.display_name_prefixed || (displayName ? 'r/' + displayName : ''),
              title: data.title || '',
              subscribers: data.subscribers ?? null,
              description: (data.public_description || '').slice(0, 200),
              url: path ? 'https://www.reddit.com' + path : '',
            });
          }
          after = d?.data?.after;
          if (!after) break;
        }
        return out;
      } catch (e) {
        return { error: String(e) };
      }
    })()`)) as Array<Record<string, unknown>> | { error: string }
    if (result && !Array.isArray(result) && "error" in result) {
      throw new Error(`reddit.subscribed: ${result.error}`)
    }
    return result
  },
})
