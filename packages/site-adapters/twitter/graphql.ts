/**
 * Minimal Twitter/X GraphQL helpers for read adapters.
 * Uses page cookies (ct0) + public web bearer token (same as X web client).
 */

import type { AdapterPage } from "../types.ts"

/** Public read-only bearer used by X web GraphQL (OpenCLI-centralized value). */
export const TWITTER_BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"

export async function getCt0(page: AdapterPage): Promise<string> {
  const ct0 = await page.evaluate(`(() => {
    const m = document.cookie.match(/(?:^|;\\\\s*)ct0=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  })()`)
  if (typeof ct0 !== "string" || !ct0) {
    throw new Error("twitter: not logged into x.com (no ct0 cookie). Sign in in Chrome first.")
  }
  return ct0
}

export function normalizeScreenName(value: unknown): string {
  const raw = String(value ?? "").trim()
  if (!raw) return ""
  try {
    const url = raw.startsWith("/") ? new URL(raw, "https://x.com") : new URL(raw)
    if (url.protocol === "https:" && (url.hostname === "x.com" || url.hostname === "twitter.com" || url.hostname.endsWith(".x.com"))) {
      const segments = url.pathname.split("/").filter(Boolean)
      if (segments.length === 1 && /^[A-Za-z0-9_]{1,15}$/.test(segments[0]!)) return segments[0]!
    }
  } catch {
    // bare handle
  }
  const candidate = raw.replace(/^@+/, "")
  return /^[A-Za-z0-9_]{1,15}$/.test(candidate) ? candidate : ""
}

export async function resolveQueryId(
  page: AdapterPage,
  operationName: string,
  fallbackId: string,
): Promise<string> {
  const resolved = await page.evaluate(`async () => {
    const operationName = ${JSON.stringify(operationName)};
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const ghResp = await fetch(
          'https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json',
          { signal: controller.signal }
        );
        clearTimeout(timeout);
        if (ghResp.ok) {
          const data = await ghResp.json();
          const entry = data && data[operationName];
          if (entry && entry.queryId) return entry.queryId;
        }
      } catch {
        clearTimeout(timeout);
      }
    } catch {}
    return null;
  }`)
  if (typeof resolved === "string" && /^[A-Za-z0-9_-]+$/.test(resolved)) return resolved
  return fallbackId
}

export async function graphqlGet(
  page: AdapterPage,
  opts: {
    queryId: string
    operation: string
    variables: Record<string, unknown>
    features: Record<string, boolean>
    fieldToggles?: Record<string, boolean>
    method?: "GET" | "POST"
  },
): Promise<unknown> {
  const ct0 = await getCt0(page)
  const method = opts.method ?? "GET"
  return page.evaluate(`async () => {
    const ct0 = ${JSON.stringify(ct0)};
    const bearer = ${JSON.stringify(TWITTER_BEARER_TOKEN)};
    const headers = {
      'Authorization': 'Bearer ' + decodeURIComponent(bearer),
      'X-Csrf-Token': ct0,
      'X-Twitter-Auth-Type': 'OAuth2Session',
      'X-Twitter-Active-User': 'yes',
      'Content-Type': 'application/json',
    };
    const variables = ${JSON.stringify(opts.variables)};
    const features = ${JSON.stringify(opts.features)};
    const fieldToggles = ${JSON.stringify(opts.fieldToggles ?? {})};
    const queryId = ${JSON.stringify(opts.queryId)};
    const operation = ${JSON.stringify(opts.operation)};
    const method = ${JSON.stringify(method)};
    let url = '/i/api/graphql/' + queryId + '/' + operation;
    const init = { method, headers, credentials: 'include' };
    if (method === 'GET') {
      url += '?variables=' + encodeURIComponent(JSON.stringify(variables))
        + '&features=' + encodeURIComponent(JSON.stringify(features));
      if (Object.keys(fieldToggles).length) {
        url += '&fieldToggles=' + encodeURIComponent(JSON.stringify(fieldToggles));
      }
    } else {
      init.body = JSON.stringify({ variables, features, fieldToggles, queryId });
    }
    const resp = await fetch(url, init);
    if (!resp.ok) {
      return { __httpError: resp.status };
    }
    return await resp.json();
  }`)
}

export function extractTweet(result: unknown, seen: Set<string>): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null
  const r = result as Record<string, unknown>
  const tw = (r.tweet as Record<string, unknown> | undefined) || r
  const legacy = (tw.legacy as Record<string, unknown> | undefined) || {}
  const restId = String(tw.rest_id || "")
  if (!restId || seen.has(restId)) return null
  seen.add(restId)
  const core = (tw.core as Record<string, unknown> | undefined) || {}
  const userResults = (core.user_results as Record<string, unknown> | undefined) || {}
  const u = (userResults.result as Record<string, unknown> | undefined) || {}
  const uLegacy = (u.legacy as Record<string, unknown> | undefined) || {}
  const uCore = (u.core as Record<string, unknown> | undefined) || {}
  const screenName = String(uLegacy.screen_name || uCore.screen_name || "unknown")
  const note = tw.note_tweet as { note_tweet_results?: { result?: { text?: string } } } | undefined
  const noteText = note?.note_tweet_results?.result?.text
  const viewsObj = tw.views as { count?: string } | undefined
  return {
    id: restId,
    author: screenName,
    text: noteText || legacy.full_text || "",
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
    replies: legacy.reply_count || 0,
    views: viewsObj?.count ? Number.parseInt(viewsObj.count, 10) : 0,
    created_at: legacy.created_at || "",
    url: `https://x.com/${screenName}/status/${restId}`,
  }
}

export function walkTimelineInstructions(
  instructions: unknown[],
  seen: Set<string>,
): { tweets: Array<Record<string, unknown>>; nextCursor: string | null } {
  const tweets: Array<Record<string, unknown>> = []
  let nextCursor: string | null = null
  for (const inst of instructions) {
    if (!inst || typeof inst !== "object") continue
    const entries = (inst as { entries?: unknown[] }).entries || []
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      const c = (e.content ?? {}) as Record<string, unknown>
      if (
        c.entryType === "TimelineTimelineCursor"
        || c.__typename === "TimelineTimelineCursor"
        || String(e.entryId || "").startsWith("cursor-bottom-")
      ) {
        if (c.cursorType === "Bottom" || String(e.entryId || "").includes("bottom")) {
          nextCursor = (c.value as string) || nextCursor
        }
        continue
      }
      const itemContent = (c.itemContent ?? {}) as Record<string, unknown>
      if (itemContent.promotedMetadata) continue
      const tweetResults = (itemContent.tweet_results ?? {}) as Record<string, unknown>
      const tw = extractTweet(tweetResults.result, seen)
      if (tw) tweets.push(tw)
      for (const item of (c.items as unknown[]) || []) {
        if (!item || typeof item !== "object") continue
        const nested = (((item as Record<string, unknown>).item as Record<string, unknown> | undefined)
          ?.itemContent as Record<string, unknown> | undefined)?.tweet_results as
          | Record<string, unknown>
          | undefined
        const nestedTw = extractTweet(nested?.result, seen)
        if (nestedTw) tweets.push(nestedTw)
      }
    }
  }
  return { tweets, nextCursor }
}
