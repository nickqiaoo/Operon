/**
 * Bilibili popular feed. Ported from the OpenCLI `clis/bilibili/hot.js` pipeline.
 * Strategy: COOKIE. Navigate bilibili.com, fetch popular API with credentials.
 */

import { defineCommand } from "../define.ts"
import type { BilibiliHotOptions, HotVideo } from "../types.ts"

export const hot = defineCommand({
  site: "bilibili",
  name: "hot",
  description: "Bilibili popular videos",
  keywords: ["热门", "B站", "哔哩哔哩"],
  domain: "www.bilibili.com",
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [{ name: "limit", type: "int", default: 20, help: "Number of videos (max useful ~50)" }],
  columns: ["rank", "title", "author", "play", "danmaku", "bvid", "url"],
  pipeline: [
    { navigate: "https://www.bilibili.com" },
    {
      evaluate: `(async () => {
  const res = await fetch('https://api.bilibili.com/x/web-interface/popular?ps=\${{ args.limit }}&pn=1', {
    credentials: 'include'
  });
  if (!res.ok) throw new Error('bilibili popular HTTP ' + res.status);
  const data = await res.json();
  if (data && data.code != null && data.code !== 0) {
    throw new Error('bilibili popular code ' + data.code + ': ' + (data.message || ''));
  }
  return (data?.data?.list || []).map((item) => ({
    title: item.title,
    author: item.owner?.name,
    play: item.stat?.view,
    danmaku: item.stat?.danmaku,
    bvid: item.bvid,
    url: item.bvid ? 'https://www.bilibili.com/video/' + item.bvid : '',
  }));
})()`,
    },
    {
      map: {
        rank: "${{ index + 1 }}",
        title: "${{ item.title }}",
        author: "${{ item.author }}",
        play: "${{ item.play }}",
        danmaku: "${{ item.danmaku }}",
        bvid: "${{ item.bvid }}",
        url: "${{ item.url }}",
      },
    },
    { limit: "${{ args.limit }}" },
  ],
}) as unknown as (options: BilibiliHotOptions) => Promise<HotVideo[]>

/** @deprecated use hot — kept for unit tests of pure helpers if needed */
export function parseLimit(raw: unknown): number {
  if (raw == null) return 20
  const n = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`bilibili.hot: limit must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return Math.min(n, 50)
}
