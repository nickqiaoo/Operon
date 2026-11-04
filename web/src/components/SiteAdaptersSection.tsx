import { useState } from "react";
import { Reveal } from "./Reveal";
import {
  Eyebrow,
  FeatureList,
  Lead,
  Muted,
  Section,
  Title,
  Window,
} from "./ui";
import { cn } from "../lib/styles";
import { useCopy, useLocale, type Locale } from "../lib/i18n";

/**
 * Site adapters: ready-made read functions for popular sites
 * (`packages/site-adapters`). Sits right after Mobile on the sidebar tone; the
 * bands after it are flipped so the page keeps alternating.
 *
 * Calls mirror real adapter signatures; every handle, title and number in the
 * results is made up.
 */

interface ResultRow {
  title: string;
  meta: string;
}

interface Scenario {
  id: string;
  site: string;
  call: string;
  copy: Record<Locale, { ask: string; summary: string; rows: ResultRow[] }>;
}

const SCENARIOS: Scenario[] = [
  {
    id: "twitter",
    site: "X / Twitter",
    call: 'twitter.search({ query: "local-first", product: "Latest", limit: 20 })',
    copy: {
      en: {
        ask: "What are people on X saying about local-first apps today?",
        summary: "20 tweets · 1.9 s",
        rows: [
          {
            title:
              "@syncwright — Shipped offline mode in a weekend. CRDTs finally feel boring, in a good way.",
            meta: "♥ 1,284 · ↻ 211 · 48k views",
          },
          {
            title:
              '@mara_builds — Hot take: most "local-first" apps are just aggressive caching.',
            meta: "♥ 862 · ↻ 97 · 31k views",
          },
          {
            title:
              "@petrichor_dev — Thread: what we learned moving 40k users off a central DB 🧵",
            meta: "♥ 640 · ↻ 158 · 22k views",
          },
        ],
      },
      zh: {
        ask: "今天 X 上大家对 local-first 应用怎么看？",
        summary: "20 条推文 · 1.9 秒",
        rows: [
          {
            title:
              "@syncwright — 一个周末就把离线模式上线了。CRDT 终于变得“无聊”了，褒义。",
            meta: "♥ 1,284 · ↻ 211 · 4.8 万浏览",
          },
          {
            title:
              "@mara_builds — 暴论：大多数 local-first 应用只是缓存做得比较激进。",
            meta: "♥ 862 · ↻ 97 · 3.1 万浏览",
          },
          {
            title:
              "@petrichor_dev — 长推：把 4 万用户从中心数据库迁出来，我们学到了什么 🧵",
            meta: "♥ 640 · ↻ 158 · 2.2 万浏览",
          },
        ],
      },
    },
  },
  {
    id: "xiaohongshu",
    site: "Xiaohongshu",
    call: 'xiaohongshu.getNote({ url: "https://xhslink.com/…" })',
    copy: {
      en: {
        ask: "Turn this Xiaohongshu travel video into a written itinerary.",
        summary: "note + video transcript · 2.4 s",
        rows: [
          {
            title: "Kyoto in 3 days, no tour bus",
            meta: "@slow_trips · 12.6k likes · 3.1k saves · video 4:12",
          },
          {
            title:
              "Transcript — “Day one, get to Fushimi Inari before seven. By nine the stairs are packed…”",
            meta: "86 subtitle lines",
          },
          {
            title: "Tags — #Kyoto #budget-travel #itinerary",
            meta: "9 images · 1 video URL",
          },
        ],
      },
      zh: {
        ask: "把这条小红书旅行视频整理成文字版行程。",
        summary: "笔记 + 视频字幕 · 2.4 秒",
        rows: [
          {
            title: "京都 3 天不跟团攻略",
            meta: "@慢慢旅行 · 1.26 万赞 · 3,100 收藏 · 视频 4:12",
          },
          {
            title: "字幕 —「第一天，七点前到伏见稻荷，九点以后台阶上全是人……」",
            meta: "86 行字幕",
          },
          {
            title: "标签 — #京都 #穷游 #行程规划",
            meta: "9 张图 · 1 个视频地址",
          },
        ],
      },
    },
  },
  {
    id: "zhihu",
    site: "Zhihu",
    call: 'zhihu.question({ id: "6021…", limit: 5 })',
    copy: {
      en: {
        ask: "Summarise the top answers to this Zhihu question about Rust in production.",
        summary: "question + 5 answers · 1.6 s",
        rows: [
          {
            title: "Is Rust worth it for a small backend team?",
            meta: "2,418 followers · 1.2M views · 356 answers",
          },
          {
            title:
              "Top answer — “Two years in: fewer pages at 3am, slower first quarter…”",
            meta: "4,903 upvotes · 612 comments",
          },
          {
            title:
              "Second answer — “Worth it only if you already hit the GC wall.”",
            meta: "2,177 upvotes · 289 comments",
          },
        ],
      },
      zh: {
        ask: "帮我总结一下这个知乎问题下，关于 Rust 上生产的高赞回答。",
        summary: "问题 + 5 个回答 · 1.6 秒",
        rows: [
          {
            title: "小团队的后端值得用 Rust 吗？",
            meta: "2,418 关注 · 120 万浏览 · 356 个回答",
          },
          {
            title:
              "最高赞 —「用了两年：半夜被叫起来的次数少了，第一个季度确实慢……」",
            meta: "4,903 赞同 · 612 评论",
          },
          {
            title: "第二 —「只有你已经撞上 GC 瓶颈时才值得。」",
            meta: "2,177 赞同 · 289 评论",
          },
        ],
      },
    },
  },
  {
    id: "reddit",
    site: "Reddit",
    call: 'reddit.subreddit({ name: "selfhosted", sort: "top", time: "week" })',
    copy: {
      en: {
        ask: "What was the self-hosting crowd excited about this week?",
        summary: "15 posts · 1.2 s",
        rows: [
          {
            title:
              "I replaced five SaaS subscriptions with one mini PC — full write-up",
            meta: "3.4k upvotes · 402 comments",
          },
          {
            title:
              "PSA: back up your reverse-proxy config before the next major upgrade",
            meta: "2.1k upvotes · 188 comments",
          },
          {
            title: "My homelab after three years (photos inside)",
            meta: "1.8k upvotes · 240 comments",
          },
        ],
      },
      zh: {
        ask: "这周自托管圈子里大家在聊什么？",
        summary: "15 个帖子 · 1.2 秒",
        rows: [
          {
            title: "我用一台迷你主机替掉了 5 个 SaaS 订阅——完整记录",
            meta: "3,400 赞 · 402 评论",
          },
          {
            title: "提醒：下次大版本升级前，先备份反向代理配置",
            meta: "2,100 赞 · 188 评论",
          },
          {
            title: "三年后的我的 homelab（内有图）",
            meta: "1,800 赞 · 240 评论",
          },
        ],
      },
    },
  },
  {
    id: "arxiv",
    site: "arXiv",
    call: 'arxiv.search({ query: "speculative decoding", limit: 10 })',
    copy: {
      en: {
        ask: "Find recent papers on speculative decoding and compare their speed-ups.",
        summary: "10 papers · 0.8 s",
        rows: [
          {
            title:
              "Draft Less, Verify More: Adaptive Lookahead for Speculative Decoding",
            meta: "cs.CL · 4 authors · PDF link",
          },
          {
            title:
              "Tree Drafts at Scale: Batched Verification on Commodity GPUs",
            meta: "cs.LG · 6 authors · PDF link",
          },
          {
            title: "When Does Speculation Pay Off? A Latency Model",
            meta: "cs.DC · 3 authors · PDF link",
          },
        ],
      },
      zh: {
        ask: "找几篇最近关于 speculative decoding 的论文，对比一下各自的加速比。",
        summary: "10 篇论文 · 0.8 秒",
        rows: [
          {
            title:
              "Draft Less, Verify More: Adaptive Lookahead for Speculative Decoding",
            meta: "cs.CL · 4 位作者 · PDF 链接",
          },
          {
            title:
              "Tree Drafts at Scale: Batched Verification on Commodity GPUs",
            meta: "cs.LG · 6 位作者 · PDF 链接",
          },
          {
            title: "When Does Speculation Pay Off? A Latency Model",
            meta: "cs.DC · 3 位作者 · PDF 链接",
          },
        ],
      },
    },
  },
];

/** Every site with a few of its functions; mirrors the adapter registry. */
const SITES: { name: Record<Locale, string>; fns: string[] }[] = [
  {
    name: { en: "X / Twitter", zh: "X / Twitter" },
    fns: ["search", "tweets", "thread", "trending", "timeline"],
  },
  {
    name: { en: "Xiaohongshu", zh: "小红书" },
    fns: ["getNote", "search", "getComments", "downloadMedia"],
  },
  {
    name: { en: "Zhihu", zh: "知乎" },
    fns: ["hot", "question", "answerComments", "user"],
  },
  {
    name: { en: "Bilibili", zh: "B 站" },
    fns: ["hot", "ranking", "video", "history"],
  },
  {
    name: { en: "Reddit", zh: "Reddit" },
    fns: ["subreddit", "search", "saved", "upvoted"],
  },
  {
    name: { en: "YouTube", zh: "YouTube" },
    fns: ["search", "video", "comments", "feed"],
  },
  { name: { en: "GitHub", zh: "GitHub" }, fns: ["trending"] },
  {
    name: { en: "Hacker News", zh: "Hacker News" },
    fns: ["top", "search", "user"],
  },
  { name: { en: "arXiv", zh: "arXiv" }, fns: ["search", "paper", "recent"] },
  {
    name: { en: "Stack Overflow", zh: "Stack Overflow" },
    fns: ["search", "read", "tag"],
  },
  {
    name: { en: "Wikipedia", zh: "维基百科" },
    fns: ["summary", "page", "search"],
  },
  {
    name: { en: "Bluesky", zh: "Bluesky" },
    fns: ["search", "profile", "thread"],
  },
  { name: { en: "Product Hunt", zh: "Product Hunt" }, fns: ["today", "hot"] },
  { name: { en: "V2EX", zh: "V2EX" }, fns: ["hot", "topic", "replies"] },
];

const COPY = {
  en: {
    eyebrow: "Site adapters",
    titleA: "Your logged-in sites, ",
    titleB: "as functions your agent can call.",
    lead: "Site adapters reuse the logins already in your browser — X, Xiaohongshu, Zhihu, Reddit and more — so there are no API keys to apply for and nothing to set up. And they don’t click through pages: each one is a packaged function that asks the site for its data directly, the way the site’s own app does, and hands back structured results. 14 sites, 90+ functions.",
    window: "Agent session",
    tablist: "Example",
    features: [
      {
        title: "Uses the login you already have",
        desc: "Adapters run inside your own browser session, so whatever you can see when signed in, your agent can read too. No developer keys, no cookies to copy and paste.",
      },
      {
        title: "Functions, not clicks",
        desc: "Instead of scrolling and clicking like a person, each adapter fetches the data the page is built from. It’s faster, and the result has the same shape every time — easy to summarise, compare or drop into a spreadsheet.",
      },
      {
        title: "Site quirks handled",
        desc: "Signed URLs, pagination, video subtitles and request pacing are taken care of. If a site’s risk control pushes back, the agent stops instead of hammering it.",
      },
    ],
  },
  zh: {
    eyebrow: "Site Adapter",
    titleA: "你登录过的网站，",
    titleB: "Agent 调个函数就能读。",
    lead: "Site Adapter 直接用你浏览器里现成的登录状态，X、小红书、知乎、Reddit 都行，不用申请 API key，也不用配置。它也不是一页页去点：每个站点都封装成了函数，像网站自己的前端一样直接请求数据，拿回来就是整理好的结果。目前支持 14 个站点、90 多个函数。",
    window: "Agent 会话",
    tablist: "示例",
    features: [
      {
        title: "用你现成的登录",
        desc: "在你自己的浏览器里运行，你登录后能看到什么，Agent 就能读到什么。不用申请开发者 key，也不用手动复制 cookie。",
      },
      {
        title: "调函数，不点页面",
        desc: "直接拿页面背后的数据，不用一屏屏滚、一下下点。速度更快，每次返回的格式都一样，方便总结、对比或者导进表格。",
      },
      {
        title: "各站点的坑都填好了",
        desc: "签名链接、分页、视频字幕、请求频率都处理好了。碰上站点风控，Agent 会先停下来，不会一个劲重试让情况更糟。",
      },
    ],
  },
};

export function SiteAdaptersSection() {
  const [activeId, setActiveId] = useState(SCENARIOS[0].id);
  const active = SCENARIOS.find((s) => s.id === activeId) ?? SCENARIOS[0];
  const t = useCopy(COPY);
  const { locale } = useLocale();
  const scenario = active.copy[locale];

  return (
    <Section id="sites" tone="sidebar">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <Title>
            {t.titleA}
            <Muted>{t.titleB}</Muted>
          </Title>
          <Lead>{t.lead}</Lead>
        </div>

        <div
          role="tablist"
          aria-label={t.tablist}
          className="no-scrollbar -mx-4 mt-10 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0"
        >
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === activeId}
              onClick={() => setActiveId(s.id)}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] whitespace-nowrap transition-colors",
                s.id === activeId
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary-hover hover:text-foreground",
              )}
            >
              {SITES.find((site) => site.name.en === s.site)?.name[locale] ??
                s.site}
            </button>
          ))}
        </div>

        <div className="mt-4">
          <Window title={t.window}>
            <div className="space-y-4 p-4 md:p-5">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-xl bg-brand-fill px-3.5 py-2 text-[13.5px] leading-[1.55] text-white">
                  {scenario.ask}
                </div>
              </div>

              <div className="rounded-lg border border-border/50 bg-sidebar px-3 py-2.5 font-mono text-[12px]">
                <div className="flex items-start gap-2.5">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-green" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-foreground">
                      <span className="text-muted-foreground">
                        siteAdapters.
                      </span>
                      {active.call}
                    </div>
                    <div className="mt-0.5 text-muted-foreground">
                      {scenario.summary}
                    </div>
                  </div>
                </div>
              </div>

              <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/50">
                {scenario.rows.map((row) => (
                  <div key={row.title} className="px-3.5 py-2.5">
                    <div className="text-[13.5px] leading-[1.5] text-foreground">
                      {row.title}
                    </div>
                    <div className="mt-0.5 text-[12px] text-muted-foreground">
                      {row.meta}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Window>
        </div>

        <div className="mt-10 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {SITES.map((site) => (
            <div
              key={site.name.en}
              className="rounded-lg border border-border/50 bg-background px-3 py-2.5"
            >
              <div className="text-[13.5px] font-medium text-foreground">
                {site.name[locale]}
              </div>
              <div className="mt-0.5 font-mono text-[11.5px] leading-[1.5] break-words text-muted-foreground">
                {site.fns.join(" · ")}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10">
          <FeatureList items={t.features} columns={3} />
        </div>
      </Reveal>
    </Section>
  );
}
