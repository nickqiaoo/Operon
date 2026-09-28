import { defineCommand } from "../define.ts"
import { requirePage, requireRows } from "../runtime/values.ts"

export interface ZhihuHotRow {
  rank: number
  title: string | undefined
  heat: string | undefined
  answers: number | undefined
  url: string | undefined
}

export const hot = defineCommand({
  site: "zhihu",
  name: "hot",
  description: "Zhihu hot list",
  keywords: ["热榜", "热门", "知乎"],
  domain: "www.zhihu.com",
  access: "read",
  browser: true,
  args: [{ name: "limit", type: "int", default: 20, help: "Number of items to return" }],
  func: async (rawPage, args): Promise<ZhihuHotRow[]> => {
    const page = requirePage(rawPage, "zhihu.hot")
    await page.goto(`https://www.zhihu.com`)
    const payload = await page.evaluate(`(async () => {
  const res = await fetch('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50', {
    credentials: 'include'
  });
  const text = await res.text();
  const d = JSON.parse(
    text.replace(/("id"\\s*:\\s*)(\\d{16,})/g, '$1"$2"')
  );
  return (d?.data || []).map((item) => {
    const t = item.target || {};
    const questionId = t.id == null ? '' : String(t.id);
    return {
      title: t.title,
      url: 'https://www.zhihu.com/question/' + questionId,
      answer_count: t.answer_count,
      follower_count: t.follower_count,
      heat: item.detail_text || '',
    };
  });
})()`)
    const items = requireRows(payload, "zhihu.hot").map((item, index) => {
      return {
        rank: index + 1,
        title: item.title as string | undefined,
        heat: item.heat as string | undefined,
        answers: item.answer_count as number | undefined,
        url: item.url as string | undefined,
      }
    })
    return items.slice(0, Number(args.limit))
  },
})
