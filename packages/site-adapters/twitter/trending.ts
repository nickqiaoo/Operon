import { defineCommand } from "../define.ts"
import { AuthRequiredError, EmptyResultError } from "../errors.ts"
import { requirePage } from "../runtime/values.ts"

export interface TwitterTrendingRow {
  rank: number
  topic: string
  category: string
}

/**
 * Twitter/X trending — OpenCLI `clis/twitter/trending.js` (DOM extract, cookie).
 */

export const trending = defineCommand({
  site: "twitter",
  name: "trending",
  description: "Twitter/X trending topics",
  domain: "x.com",
  access: "read",
  browser: true,
  args: [{ name: "limit", type: "int", default: 20, help: "Number of trends" }],
  func: async (rawPage, kwargs): Promise<TwitterTrendingRow[]> => {
    const page = requirePage(rawPage, "twitter.trending")
    const limit = Number(kwargs.limit) || 20
    await page.goto("https://x.com/explore/tabs/trending")
    await page.wait(3)
    const loggedIn = await page.evaluate(`(() => {
      return document.cookie.split(';').some((c) => c.trim().startsWith('ct0='));
    })()`)
    if (!loggedIn) {
      throw new AuthRequiredError("x.com", "twitter.trending: not logged into x.com (no ct0 cookie). Sign in in Chrome first.")
    }
    await page.wait(2)
    const trends = await page.evaluate(`(() => {
      const items = [];
      const cells = document.querySelectorAll('[data-testid="trend"]');
      cells.forEach((cell) => {
        const text = cell.textContent || '';
        if (text.includes('Promoted')) return;
        const container = cell.querySelector(':scope > div');
        if (!container) return;
        const divs = container.children;
        if (divs.length < 2) return;
        const topic = divs[1].textContent.trim();
        if (!topic) return;
        const catText = divs[0].textContent.trim();
        const category = catText.replace(/^\\d+\\s*/, '').replace(/^\\xB7\\s*/, '').trim();
        items.push({ rank: items.length + 1, topic, category });
      });
      return items;
    })()`)
    if (!Array.isArray(trends) || trends.length === 0) {
      throw new EmptyResultError("twitter", "twitter.trending: no trends found (page structure may have changed, or still loading)")
    }
    return (trends as TwitterTrendingRow[]).slice(0, limit)
  },
})
