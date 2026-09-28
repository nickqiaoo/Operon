/**
 * `xiaohongshu.search`: notes for a keyword, with signed URLs that
 * `getNote` / `getComments` accept directly.
 *
 * Page logic from OpenCLI clis/xiaohongshu/search.js: the search API returns
 * empty items to outside callers, so this reads the rendered masonry, scrolling
 * one viewport at a time (the grid is virtualized: jumping further skips cards).
 */

import { defineCommand } from "../define.ts"
import { AuthRequiredError, CommandExecutionError, EmptyResultError, TimeoutError } from "../errors.ts"
import type { AdapterPage } from "../types.ts"
import { SecurityBlockError } from "./risk-control.ts"
import { XHS_WEB_HOST, isRecord, requirePage, toCleanString } from "./shared.ts"

export interface XhsSearchResult {
  title: string
  author: string
  authorUrl: string
  likes: string
  /** Signed note URL; pass to getNote / getComments. */
  url: string
  /** Approximate, decoded from the note id's timestamp (UTC+8 date). */
  publishedAt: string
}

const FILTERS = {
  sort: {
    group: "排序依据",
    defaultValue: "general",
    options: { general: "综合", latest: "最新", mostLiked: "最多点赞", mostCommented: "最多评论", mostCollected: "最多收藏" },
  },
  noteType: { group: "笔记类型", defaultValue: "all", options: { all: "不限", video: "视频", image: "图文" } },
  publishTime: {
    group: "发布时间",
    defaultValue: "any",
    options: { any: "不限", day: "一天内", week: "一周内", halfYear: "半年内" },
  },
} as const

type FilterName = keyof typeof FILTERS
const FILTER_SETTLE_MS = 8000

/** Note ids are ObjectIDs: the first 8 hex digits are a Unix timestamp. */
export function noteIdToDate(url: string): string {
  const match = url.match(/\/(?:search_result|explore|note)\/([0-9a-f]{24})(?=[?#/]|$)/i)
  if (!match) return ""
  const ts = parseInt(match[1]!.substring(0, 8), 16)
  if (!ts || ts < 1_000_000_000 || ts > 4_000_000_000) return ""
  return new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10)
}

const WAIT_FOR_CONTENT_JS = `
  new Promise((resolve) => {
    const detect = () => {
      if (document.querySelector('section.note-item, section:has(a[href*="/search_result/"]), section:has(a[href*="/explore/"])')) return 'content';
      const bodyText = document.body?.innerText || '';
      if (/登录后查看搜索结果/.test(bodyText) || document.querySelector('#login-btn')) return 'login_wall';
      if (/请求太频繁|访问频次异常|安全限制/.test(bodyText)) return 'security_block';
      if (document.querySelector('.search-empty-wrapper')) return 'empty';
      return null;
    };
    const found = detect();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const result = detect();
      if (result) { observer.disconnect(); resolve(result); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve('timeout'); }, 8000);
  })
`

/** Clicks each requested chip in the filter panel and waits for the grid to settle. */
function buildApplyFiltersJs(requests: Array<{ group: string; option: string }>): string {
  return `
    (async () => {
      const requests = ${JSON.stringify(requests)};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const text = (el) => (el?.textContent || '').replace(/\\s+/g, '').trim();
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const visibleMatches = (root, selector) => Array.from(root.querySelectorAll(selector)).filter(visible);
      const authBlocked = () => /登录后查看搜索结果/.test(document.body?.innerText || '') || visible(document.querySelector('#login-btn'));
      const panels = () => visibleMatches(document, '.search-layout__top > .filter > .filter-panel');
      const triggers = () => visibleMatches(document, '.search-layout__top > .filter');
      const openPanel = async () => {
        let clicked = false;
        for (let attempt = 0; attempt < 16; attempt++) {
          if (authBlocked()) return { status: 'auth' };
          const current = panels();
          if (current.length === 1) return { status: 'ok', panel: current[0] };
          const t = triggers();
          if (!clicked && t.length === 1) { t[0].click(); clicked = true; }
          await sleep(100);
        }
        return { status: 'layout', detail: 'filter panel not found' };
      };
      const findOption = (panel, request) => {
        const groups = visibleMatches(panel, '.filters').filter((group) => {
          const label = Array.from(group.children).find((child) => child.tagName === 'SPAN');
          return text(label) === request.group;
        });
        if (groups.length !== 1) return null;
        const options = visibleMatches(groups[0], '.tag-container > .tags').filter((o) => text(o) === request.option);
        return options.length === 1 ? options[0] : null;
      };
      const ready = () => visibleMatches(document, 'section.note-item, section:has(a[href*="/search_result/"]), section:has(a[href*="/explore/"]), .search-empty-wrapper').length > 0;
      const snapshot = () => JSON.stringify(visibleMatches(document, 'section.note-item, section:has(a[href*="/search_result/"])')
        .map((row) => row.querySelector('a[href*="/search_result/"], a[href*="/explore/"]')?.getAttribute('href') || ''));

      for (const request of requests) {
        const opened = await openPanel();
        if (opened.status !== 'ok') return opened;
        const option = findOption(opened.panel, request);
        if (!option) return { status: 'layout', detail: request.group + '/' + request.option + ' not found' };
        if (option.classList.contains('active')) continue;
        const clickedAt = Date.now();
        option.click();
        let stable = 0;
        let previous = '';
        while (Date.now() - clickedAt < ${FILTER_SETTLE_MS}) {
          if (authBlocked()) return { status: 'auth' };
          const current = snapshot();
          if (Date.now() - clickedAt >= 1500 && ready()) {
            stable = current === previous ? stable + 1 : 1;
            previous = current;
            if (stable >= 3) break;
          }
          await sleep(200);
        }
        if (stable < 3) return { status: 'timeout', detail: request.group + '/' + request.option };
      }
      return { status: 'ok' };
    })()
  `
}

/**
 * Scroll-and-harvest: merges rows across frames keyed by note id (the grid
 * is virtualized, so cards leave the DOM), stops at `target` titled rows, the
 * time budget, or three idle rounds with neither new data nor movement.
 */
function buildHarvestJs(target: number, maxRounds: number, budgetMs: number): string {
  return `
    (async () => {
      const webHost = ${JSON.stringify(XHS_WEB_HOST)};
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const cleanText = (v) => (v || '').replace(/\\s+/g, ' ').trim();
      const stripDateSuffix = (value) => {
        const t = cleanText(value);
        return t.replace(/\\s*(?:\\d{1,2}天前|\\d+小时前|\\d+分钟前|\\d+秒前|刚刚|昨天|前天|\\d+周前|\\d+个月前|\\d{1,2}-\\d{1,2}|\\d{4}-\\d{1,2}-\\d{1,2})$/u, '').trim() || t;
      };
      const normalizeUrl = (href) => {
        if (!href) return '';
        try {
          const u = new URL(href, 'https://' + webHost + '/');
          return u.protocol === 'https:' && u.hostname.toLowerCase() === webHost ? u.href : '';
        } catch { return ''; }
      };
      const noteKey = (url) => {
        try {
          const m = new URL(url).pathname.match(/^\\/(?:search_result|explore|note)\\/([0-9a-f]{24})\\/?$/i);
          return m ? m[1].toLowerCase() : '';
        } catch { return ''; }
      };
      const isSigned = (url) => { try { return Boolean(new URL(url).searchParams.get('xsec_token')); } catch { return false; } };
      const cards = () => {
        const byClass = document.querySelectorAll('section.note-item');
        if (byClass.length > 0) return Array.from(byClass);
        const sections = new Set();
        for (const a of document.querySelectorAll('a[href*="/search_result/"], a[href*="/explore/"]')) {
          const s = a.closest('section');
          if (s) sections.add(s);
        }
        return Array.from(sections);
      };
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const extractRows = () => {
        const rows = [];
        for (const el of cards()) {
          if (el.classList?.contains('query-note-item') || !visible(el)) continue;
          const link = el.querySelector('a.cover.mask') || el.querySelector('a[href*="/search_result/"]')
            || el.querySelector('a[href*="/explore/"]') || el.querySelector('a[href*="/note/"]');
          const url = normalizeUrl(link?.getAttribute('href') || '');
          if (!url) continue;
          let author = cleanText(el.querySelector('a.author .name, .author-name, .nick-name, .name')?.textContent || '');
          const authorWrap = el.querySelector('a.author');
          if (!author && authorWrap) author = stripDateSuffix(authorWrap.textContent || '');
          let title = cleanText(el.querySelector('.title, .note-title, a.title, .footer .title span')?.textContent || '');
          if (!title) title = cleanText(link?.querySelector('span')?.textContent || '');
          const authorLink = el.querySelector('a.author, a[href*="/user/profile/"]');
          rows.push({
            title,
            author,
            likes: cleanText(el.querySelector('.count, .like-count, .like-wrapper .count')?.textContent || '0'),
            url,
            authorUrl: normalizeUrl(authorLink?.getAttribute('href') || ''),
          });
        }
        return rows;
      };
      const merge = (acc, row) => {
        const key = noteKey(row.url);
        if (!key) return false;
        const prev = acc.get(key);
        if (!prev) { acc.set(key, { ...row }); return true; }
        let changed = false;
        for (const f of ['title', 'author', 'authorUrl']) {
          if (!prev[f] && row[f]) { prev[f] = row[f]; changed = true; }
        }
        if ((!prev.likes || prev.likes === '0') && row.likes && row.likes !== '0') { prev.likes = row.likes; changed = true; }
        if (isSigned(row.url) && !isSigned(prev.url)) { prev.url = row.url; changed = true; }
        return changed;
      };
      const root = document.scrollingElement || document.documentElement || document.body;
      const metrics = () => ({
        top: Math.max(window.scrollY || 0, root?.scrollTop || 0),
        height: Math.max(root?.scrollHeight || 0, document.body?.scrollHeight || 0),
        client: Math.max(window.innerHeight || 0, root?.clientHeight || 0),
      });

      const acc = new Map();
      const startedAt = Date.now();
      let previous = null;
      let idle = 0;
      let round = 0;
      let cardCount = 0;
      let stopReason = '';
      let securityBlock = false;
      while (true) {
        round++;
        if (/请求太频繁|访问频次异常|安全限制/.test(document.body?.innerText || '')) { securityBlock = true; stopReason = 'security-block'; break; }
        const rows = extractRows();
        cardCount = rows.length;
        let changed = false;
        for (const row of rows) if (merge(acc, row)) changed = true;
        const m = metrics();
        const moved = !previous || m.top !== previous.top || m.height !== previous.height || m.client !== previous.client;
        idle = previous && !changed && !moved ? idle + 1 : 0;
        const usable = Array.from(acc.values()).filter((r) => r.title).length;
        const atBottom = m.height <= m.client + 2 || m.top + m.client >= m.height - 8;
        if (usable >= ${target}) { stopReason = 'target'; break; }
        if (Date.now() - startedAt >= ${budgetMs}) { stopReason = 'budget'; break; }
        if (round >= ${maxRounds}) { stopReason = 'max-rounds'; break; }
        if (idle >= 3) { stopReason = atBottom ? 'exhausted' : 'wedged'; break; }
        previous = m;
        window.scrollBy(0, Math.max(1, Math.min(900, m.client || 900)));
        await wait(atBottom ? 1000 : 500);
      }
      const tops = new Set();
      for (const card of cards()) {
        if (!card.classList?.contains('query-note-item')) tops.add(Math.round(card.getBoundingClientRect().top));
      }
      const feed = document.querySelector('.feeds-container');
      return {
        rows: Array.from(acc.values()),
        diag: { securityBlock, stopReason, cardCount, feedClientHeight: feed ? feed.clientHeight : null, distinctCardTops: tops.size },
      };
    })()
  `
}

interface Harvest {
  rows: unknown[]
  diag: { securityBlock: boolean; cardCount: number; feedClientHeight: number | null; distinctCardTops: number }
}

/**
 * A known bad render: every card stacked at one position in a zero-height
 * feed. Only a fresh tab recovers it.
 */
function isCollapsedRender(diag: Harvest["diag"]): boolean {
  return diag.cardCount > 1 && diag.feedClientHeight === 0 && diag.distinctCardTops === 1
}

function resolveFilters(kwargs: Record<string, unknown>): Array<{ group: string; option: string }> {
  const out: Array<{ group: string; option: string }> = []
  for (const name of Object.keys(FILTERS) as FilterName[]) {
    const def = FILTERS[name]
    const value = String(kwargs[name] ?? def.defaultValue)
    const options: Record<string, string> = def.options
    const option = options[value]
    if (!option) throw new CommandExecutionError(`xiaohongshu.search: ${name} must be one of ${Object.keys(options).join(", ")}`)
    if (value !== def.defaultValue) out.push({ group: def.group, option })
  }
  return out
}

async function harvestOnce(
  page: AdapterPage,
  limit: number,
  filters: Array<{ group: string; option: string }>,
): Promise<Harvest | "empty"> {
  // The waits below run inside the page while it renders results, so they go
  // through the privileged channel: the read-only guard would block the
  // page's own DOM inserts for as long as they run.
  const state = await page.evaluateWrite(WAIT_FOR_CONTENT_JS)
  if (state === "login_wall") throw new AuthRequiredError(XHS_WEB_HOST, "Xiaohongshu search results require login")
  if (state === "security_block") {
    throw new SecurityBlockError("Xiaohongshu search was blocked by rate or security controls.", "Wait before retrying.")
  }
  if (state === "empty") return "empty"
  if (state === "timeout") throw new TimeoutError("xiaohongshu search results", 8)

  if (filters.length > 0) {
    const applied = await page.evaluateWrite(buildApplyFiltersJs(filters), { timeoutMs: 60_000 })
    const status = isRecord(applied) ? applied.status : undefined
    const detail = isRecord(applied) ? toCleanString(applied.detail) : ""
    if (status === "auth") throw new AuthRequiredError(XHS_WEB_HOST, "Xiaohongshu search filters require login")
    if (status === "timeout") throw new TimeoutError(`xiaohongshu search filter ${detail}`, FILTER_SETTLE_MS / 1000)
    if (status !== "ok") throw new CommandExecutionError(`xiaohongshu.search: could not apply filter (${detail || "unknown"})`)
  }

  const budgetMs = 10_000 + Math.ceil(((limit - 1) * 35_000) / 99)
  const maxRounds = 12 + Math.ceil(((limit - 1) * 48) / 99)
  const payload = await page.evaluateWrite(buildHarvestJs(limit, maxRounds, budgetMs), { timeoutMs: budgetMs + 30_000 })
  if (!isRecord(payload) || !Array.isArray(payload.rows) || !isRecord(payload.diag)) {
    throw new CommandExecutionError("xiaohongshu.search: unexpected harvest payload")
  }
  const diag = payload.diag
  const harvest: Harvest = {
    rows: payload.rows,
    diag: {
      securityBlock: diag.securityBlock === true,
      cardCount: Number(diag.cardCount) || 0,
      feedClientHeight: typeof diag.feedClientHeight === "number" ? diag.feedClientHeight : null,
      distinctCardTops: Number(diag.distinctCardTops) || 0,
    },
  }
  if (harvest.diag.securityBlock) {
    throw new SecurityBlockError("Xiaohongshu search was blocked by rate or security controls.", "Wait before retrying.")
  }
  return harvest
}

export const search = defineCommand({
  site: "xiaohongshu",
  name: "search",
  description:
    "Search Xiaohongshu notes by keyword. Returns titles, authors, likes and signed note URLs to pass to getNote / getComments.",
  keywords: ["小红书", "搜索", "笔记", "rednote", "xhs"],
  domain: XHS_WEB_HOST,
  access: "read",
  strategy: "cookie",
  browser: true,
  args: [
    { name: "query", required: true, help: "Search keyword" },
    { name: "limit", type: "int", default: 20, help: "Number of results (1-100)" },
    { name: "sort", default: "general", choices: Object.keys(FILTERS.sort.options), help: "Sort order" },
    { name: "noteType", default: "all", choices: Object.keys(FILTERS.noteType.options), help: "Only video or image notes" },
    { name: "publishTime", default: "any", choices: Object.keys(FILTERS.publishTime.options), help: "Publish time range" },
  ],
  func: async (rawPage, kwargs): Promise<XhsSearchResult[]> => {
    const page = requirePage(rawPage, "xiaohongshu.search")
    const limit = Number(kwargs.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new CommandExecutionError(`xiaohongshu.search: limit must be between 1 and 100, got ${kwargs.limit}`)
    }
    const filters = resolveFilters(kwargs)
    const url = `https://${XHS_WEB_HOST}/search_result?keyword=${encodeURIComponent(String(kwargs.query))}&source=web_search_result_notes`
    await page.goto(url)
    let harvest = await harvestOnce(page, limit, filters)
    if (harvest !== "empty" && isCollapsedRender(harvest.diag)) {
      await page.replaceTab(url)
      harvest = await harvestOnce(page, limit, filters)
      if (harvest !== "empty" && isCollapsedRender(harvest.diag)) {
        throw new CommandExecutionError("xiaohongshu.search: the result grid stayed collapsed after reopening the tab; retry later.")
      }
    }
    const rows = harvest === "empty" ? [] : harvest.rows
    const results: XhsSearchResult[] = []
    for (const row of rows) {
      if (!isRecord(row)) continue
      const title = toCleanString(row.title)
      const noteUrl = toCleanString(row.url)
      if (!title || !noteUrl) continue
      results.push({
        title,
        author: toCleanString(row.author),
        authorUrl: toCleanString(row.authorUrl),
        likes: toCleanString(row.likes) || "0",
        url: noteUrl,
        publishedAt: noteIdToDate(noteUrl),
      })
      if (results.length >= limit) break
    }
    if (results.length === 0) throw new EmptyResultError("xiaohongshu.search", "No notes found for this query.")
    return results
  },
})
