/**
 * `xiaohongshu.feed`: the home recommendation feed from the hydrated Pinia
 * store (OpenCLI clis/xiaohongshu/feed.js). The store carries each first-screen
 * note's xsecToken, so the URLs work with getNote.
 */

import { defineCommand } from "../define.ts"
import { CommandExecutionError, EmptyResultError } from "../errors.ts"
import { XHS_WEB_HOST, isRecord, requirePage, toCleanString } from "./shared.ts"

const FEEDS_READ_JS = `
  (() => {
    const probe = (el) => el?.__vue_app__?.config?.globalProperties?.$pinia ?? null;
    let pinia = probe(document.querySelector('#app'));
    if (!pinia) {
      for (const el of document.querySelectorAll('*')) {
        pinia = probe(el);
        if (pinia) break;
      }
    }
    if (!pinia || !pinia._s) return { error: 'no_pinia' };
    const store = pinia._s.get('feed');
    if (!store) return { error: 'no_feed_store' };
    if (!Array.isArray(store.feeds)) return { error: 'feeds_not_array' };
    return {
      items: store.feeds.map((entry) => {
        const card = entry?.noteCard ?? {};
        return {
          id: entry?.id ?? '',
          title: card.displayTitle ?? '',
          type: card.type ?? '',
          author: card.user?.nickname ?? card.user?.nickName ?? '',
          likes: card.interactInfo?.likedCount ?? '',
          // The note's token is on the entry; card.user.xsecToken is the author's.
          xsecToken: entry?.xsecToken ?? '',
        };
      }),
    };
  })()
`

export interface XhsFeedItem {
  id: string
  title: string
  type: string
  author: string
  likes: string
  url: string
}

export const feed = defineCommand({
  site: "xiaohongshu",
  name: "feed",
  description: "Xiaohongshu home recommendation feed (first screen), with signed note URLs for getNote.",
  keywords: ["小红书", "首页", "推荐", "发现", "rednote", "xhs"],
  domain: XHS_WEB_HOST,
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [{ name: "limit", type: "int", default: 20, help: "Number of notes" }],
  func: async (rawPage, kwargs): Promise<XhsFeedItem[]> => {
    const page = requirePage(rawPage, "xiaohongshu.feed")
    const limit = Math.max(1, Number(kwargs.limit) || 20)
    await page.goto(`https://${XHS_WEB_HOST}/explore`)
    await page.wait({ time: 2 })
    const data = await page.evaluate(FEEDS_READ_JS)
    if (!isRecord(data)) throw new CommandExecutionError("xiaohongshu.feed: unexpected page payload")
    if (data.error) {
      throw new CommandExecutionError(`xiaohongshu.feed: ${toCleanString(data.error)}`, "The page may still be loading; retry.")
    }
    const items: XhsFeedItem[] = []
    for (const row of Array.isArray(data.items) ? data.items : []) {
      if (!isRecord(row)) continue
      const id = toCleanString(row.id)
      const token = toCleanString(row.xsecToken)
      if (!id || !token) continue
      const url = new URL(`https://${XHS_WEB_HOST}/explore/${encodeURIComponent(id)}`)
      url.searchParams.set("xsec_token", token)
      url.searchParams.set("xsec_source", "")
      items.push({
        id,
        title: toCleanString(row.title),
        type: toCleanString(row.type),
        author: toCleanString(row.author),
        likes: toCleanString(row.likes),
        url: url.toString(),
      })
      if (items.length >= limit) break
    }
    if (items.length === 0) throw new EmptyResultError("xiaohongshu.feed", "No feed items in the page store.")
    return items
  },
})
