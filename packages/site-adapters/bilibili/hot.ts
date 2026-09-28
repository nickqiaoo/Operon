import { defineCommand } from "../define.ts"
import { ArgumentError } from "../errors.ts"
import { requirePage, requireRows } from "../runtime/values.ts"

export interface BilibiliHotRow {
  rank: number
  title: string | undefined
  author: string | undefined
  play: number | undefined
  danmaku: number | undefined
  bvid: string | undefined
  url: string | undefined
}

/**
 * Bilibili popular feed.
 * Fetch the popular API in the Chrome session.
 */

export const hot = defineCommand({
  site: "bilibili",
  name: "hot",
  description: "Bilibili popular videos",
  keywords: ["热门", "B站", "哔哩哔哩"],
  domain: "www.bilibili.com",
  access: "read",
  browser: true,
  args: [{ name: "limit", type: "int", default: 20, help: "Number of videos (max useful ~50)" }],
  func: async (rawPage, args): Promise<BilibiliHotRow[]> => {
    const page = requirePage(rawPage, "bilibili.hot")
    await page.goto(`https://www.bilibili.com`)
    const payload = await page.evaluate(`(async () => {
  const res = await fetch('https://api.bilibili.com/x/web-interface/popular?ps=${args.limit}&pn=1', {
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
})()`)
    const items = requireRows(payload, "bilibili.hot").map((item, index) => {
      return {
        rank: index + 1,
        title: item.title as string | undefined,
        author: item.author as string | undefined,
        play: item.play as number | undefined,
        danmaku: item.danmaku as number | undefined,
        bvid: item.bvid as string | undefined,
        url: item.url as string | undefined,
      }
    })
    return items.slice(0, Number(args.limit))
  },
})

/** @deprecated use hot — kept for unit tests of pure helpers if needed */
export function parseLimit(raw: unknown): number {
  if (raw == null) return 20
  const n = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new ArgumentError(`bilibili.hot: limit must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return Math.min(n, 50)
}
