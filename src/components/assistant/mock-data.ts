import type { Activity, AssistantMessage, AuditRecord, ProfileFile, ScheduleItem, StandingGrant } from "./types"

/**
 * Placeholder content for the UI prototype. Times are relative to page load so
 * the day separators and "2h ago" labels always read sensibly.
 */
const now = Date.now()
const min = 60_000
const hour = 60 * min
const ago = (ms: number) => now - ms

export const MOCK_IDENTITY = `---
name: Muse
user_name: Nick
avatar: default
---

Your personal assistant. Keeps an eye on things so you don't have to.
`

export const MOCK_SOUL = `# Soul

- Speak like a capable friend, not a customer-service script. Short sentences.
- Lead with the result. Only explain the process when something went wrong.
- When unsure whether something matters, say it once and let Nick decide.
- Never pretend a task succeeded. "Done, but couldn't get X" is a fine answer.
`

export const MOCK_MEMORY = `# About Nick
- Building operon (desktop AI dev tool). Main repo: Nickqiaoo/Operon
- Email: nickqiaoo@gmail.com
- Based in Beijing, prefers Chinese in conversation

# People
- 小王 — college roommate, lives in Suzhou

# Preferences
- Morning brief at 08:40, keep it under 5 bullets
- Drives rather than takes the train for trips under 1000km

# In progress
- 国庆苏州自驾（10/1–10/4），行程在 Notion「国庆旅行」
- operon-agents alpha.15 publish job failed on 9/29, waiting for a fix
`

export const MOCK_HEARTBEAT = `# Heartbeat
- 看 memory.md「In progress」，到了该跟进的就问我一句
- 银行、安全类邮件优先；newsletter 忽略
- 留意苏州博物馆国庆预约是否放票 (until 2026-10-03)
`

export const MOCK_PROFILE: ProfileFile[] = [
  { name: "identity", content: MOCK_IDENTITY, updatedAt: ago(9 * 24 * hour), updatedBy: "user" },
  { name: "soul", content: MOCK_SOUL, updatedAt: ago(9 * 24 * hour), updatedBy: "user" },
  { name: "memory", content: MOCK_MEMORY, updatedAt: ago(2 * hour), updatedBy: "assistant" },
  { name: "heartbeat", content: MOCK_HEARTBEAT, updatedAt: ago(5 * hour), updatedBy: "assistant" },
]

export const MOCK_ACTIVITIES: Activity[] = [
  {
    id: "act-hsbc",
    title: "Check HSBC security email",
    summary: "PIN change notice on iPhone 17, flagged to you",
    status: "done",
    source: "heartbeat",
    startedAt: ago(38 * min),
    finishedAt: ago(37 * min),
    report: "19:02 汇丰发来邮件：iPhone 17 上的流动理财 PIN 已变更。邮件发件域名和历史通知一致，未发现钓鱼特征，但无法确认是否本人操作，已提醒你核实。",
    steps: [
      { id: "s1", label: "Listed unread mail since 20:08", status: "done", tool: "gmail_search", args: { q: "is:unread after:1759147680" }, result: "3 messages\n- HSBC HK <alerts@hsbc.com.hk> 流动理财 PIN 已变更 (19:02)\n- GitHub <noreply@github.com> [nickqiaoo/operon-agents] Run failed: Publish (08:29)\n- Substack <weekly@…> This week in AI (07:00)", at: ago(38 * min) },
      { id: "s2", label: "Read the HSBC notice", status: "done", tool: "gmail_read", args: { id: "18f2a…" }, result: "From: HSBC HK <alerts@hsbc.com.hk>\nSubject: 流动理财 PIN 已变更\n\n您在 iPhone 17 上的流动理财 PIN 已按要求变更成功。如非本人操作，请立即致电 2233 3000。", at: ago(38 * min) },
      { id: "s3", label: "Compared sender with past HSBC mail", status: "done", tool: "gmail_search", args: { q: "from:hsbc.com.hk" }, result: "12 messages, all from alerts@hsbc.com.hk (same DKIM domain)", at: ago(37 * min) },
    ],
  },
  {
    id: "act-trip",
    title: "Update Suzhou National Day itinerary",
    summary: "Removed Suzhou Museum; reservation status for the rest is incomplete",
    status: "partial",
    startedAt: ago(5 * hour + 20 * min),
    finishedAt: ago(5 * hour),
    report: "已把国庆苏州行程中的苏州博物馆删掉，并更新了 A 组路线。\n\n行程里其余景点的预约情况没能全部整理出来：Notion 数据源查询失败，只拿到了页面正文里写到的 3 个景点。",
    steps: [
      { id: "s1", label: "Read the Notion skill guide", status: "done", tool: "read_skill", args: { name: "notion" }, result: "# Notion\nUse notion_search to find pages, notion_fetch to read, notion_update_page to edit…", at: ago(5 * hour + 20 * min) },
      { id: "s2", label: "Found the 国庆旅行 page", status: "done", tool: "notion_search", args: { query: "国庆旅行" }, result: "1 result: 国庆旅行 (page 3e9b6ba3e6a88147b71defeb36bedecf), edited 2 days ago", at: ago(5 * hour + 18 * min) },
      { id: "s3", label: "Fetched the itinerary content", status: "done", tool: "notion_fetch", args: { id: "3e9b6ba3e6a88147b71defeb36bedecf" }, result: "# 国庆旅行\n## A组 园林博物馆片\n苏州博物馆 → 拙政园（步行4分）→ 狮子林\n## B组 古镇片\n平江路 → 山塘街\n…", at: ago(5 * hour + 15 * min) },
      { id: "s4", label: "Removed Suzhou Museum from group A", status: "done", tool: "notion_update_page", args: { page_id: "3e9b6ba3…", command: "update_content" }, result: "Page updated (1 block changed)", at: ago(5 * hour + 9 * min) },
      { id: "s5", label: "Queried the attractions database", status: "failed", tool: "notion_query_data_source", args: { data_source: "attractions" }, result: "Error: object_not_found — Could not find data source with ID: attractions. Make sure the relevant pages and databases are shared with your integration.", at: ago(5 * hour + 4 * min) },
      { id: "s6", label: "Summarized reservation needs from page text", status: "done", tool: "summarize", at: ago(5 * hour + 1 * min) },
    ],
  },
  {
    id: "act-route",
    title: "Compare Beijing → Suzhou routes",
    summary: "G2 is 1,180 km; G15 distance not available",
    status: "partial",
    startedAt: ago(7 * hour + 30 * min),
    finishedAt: ago(7 * hour + 20 * min),
    report: "京沪高速 G2 全程约 1,180 公里，约 12 小时。沈海高速 G15 方案没拿到可靠的里程数据，建议走 G2。",
    steps: [
      { id: "s1", label: "Planned a driving route", status: "done", tool: "maps_direction_driving", at: ago(7 * hour + 30 * min) },
      { id: "s2", label: "Looked up G15 mileage", status: "failed", tool: "web_search", args: { q: "北京 苏州 G15 里程" }, at: ago(7 * hour + 25 * min) },
    ],
  },
  {
    id: "act-publish",
    title: "Pull the failed publish workflow log",
    summary: "Found the cause: npm OIDC 404 on first publish of a new package",
    status: "done",
    startedAt: ago(26 * hour),
    finishedAt: ago(25 * hour + 50 * min),
    report: "operon-agents 9/29 08:28 main 分支 commit 6bfa562 的 Publish 失败，原因是新包首次发布走 OIDC 返回 404——新包第一次必须手工发布。",
    steps: [
      { id: "s1", label: "Listed recent workflow runs", status: "done", tool: "github_list_runs", args: { repo: "nickqiaoo/operon-agents" }, at: ago(26 * hour) },
      { id: "s2", label: "Downloaded the publish job log", status: "done", tool: "github_job_log", at: ago(25 * hour + 55 * min) },
    ],
  },
  {
    id: "act-podcast",
    title: "Make the daily tech & US stocks podcast",
    summary: "10-minute episode generated and saved",
    status: "done",
    source: "schedule",
    startedAt: ago(28 * hour),
    finishedAt: ago(27 * hour + 45 * min),
    report: "生成了 10 分钟的科技美股播客，保存在 ~/.operon/assistant/podcasts/。",
    steps: [
      { id: "s1", label: "Gathered overnight market news", status: "done", tool: "web_search", at: ago(28 * hour) },
      { id: "s2", label: "Wrote the script", status: "done", tool: "write_file", at: ago(27 * hour + 55 * min) },
      { id: "s3", label: "Rendered audio", status: "done", tool: "tts", at: ago(27 * hour + 47 * min) },
    ],
  },
]

export const MOCK_MESSAGES: AssistantMessage[] = [
  { id: "m1", role: "user", text: "帮我看下 operon-agents 昨天那次 publish 为什么挂了", createdAt: ago(26 * hour + 2 * min) },
  { id: "m2", role: "assistant", text: "我去翻一下 workflow 日志，等我消息。", createdAt: ago(26 * hour + 1 * min) },
  {
    id: "m3",
    role: "assistant",
    text: "找到了：新包第一次发布走 OIDC 会 404，npm 要求新包首发必须手工发。手工发一次之后，后续的 CI 发布就正常了。",
    createdAt: ago(25 * hour + 50 * min),
    trigger: { kind: "worker", activityId: "act-publish" },
    activityId: "act-publish",
  },
  { id: "m4", role: "user", text: "国庆去苏州，把行程里的苏州博物馆删掉，再看看其他景点哪些要提前预约", createdAt: ago(5 * hour + 22 * min) },
  { id: "m5", role: "assistant", text: "好，我去改 Notion 里的行程。", createdAt: ago(5 * hour + 21 * min) },
  {
    id: "m6",
    role: "assistant",
    text: "苏州博物馆删掉了，A 组路线也顺手调了。\n\n预约情况没整理全——Notion 的景点数据库查询失败了，我只从页面正文里找到 3 个要提前约的：拙政园、留园、苏州博物馆西馆。要我换个方式再查一遍吗？",
    createdAt: ago(5 * hour),
    trigger: { kind: "worker", activityId: "act-trip" },
    activityId: "act-trip",
    remembered: ["国庆苏州自驾 10/1–10/4"],
  },
  {
    id: "m7",
    role: "assistant",
    text: "刚看到一条值得留意的安全提醒：今晚 19:02 汇丰发来邮件，说你在 **iPhone 17** 上的流动理财 PIN 已变更。\n\n如果是你自己改的，忽略就行。如果不是，尽快通过汇丰官方渠道确认——App 里找线上客服，或者打 2233 3000。别直接回那封邮件。",
    createdAt: ago(37 * min),
    trigger: { kind: "heartbeat" },
    activityId: "act-hsbc",
  },
]

export const MOCK_AUDIT: AuditRecord[] = [
  {
    id: "a1",
    title: "Read mail in Gmail",
    intent: "Check unread mail since the last heartbeat for anything that needs you.",
    icon: "mail",
    decision: "auto_allowed",
    at: ago(38 * min),
    args: { q: "is:unread after:1759147680", maxResults: 20 },
  },
  {
    id: "a2",
    title: "Edit pages in Notion",
    intent: "Remove Suzhou Museum from the 国庆旅行 itinerary and check which other attractions need reservations.",
    icon: "notion",
    decision: "allowed_once",
    at: ago(5 * hour + 9 * min),
    args: {
      page_id: "3e9b6ba3e6a88147b71defeb36bedecf",
      command: "update_content",
      content_updates: [{ old_str: "A组 园林博物馆片：苏州博物馆 → 拙政园", new_str: "A组 园林片：拙政园" }],
    },
  },
  {
    id: "a3",
    title: "Access api.github.com",
    intent: "Fetch the failed Publish workflow log for commit 6bfa562 on nickqiaoo/operon-agents.",
    icon: "github",
    decision: "auto_allowed",
    at: ago(25 * hour + 55 * min),
    args: { url: "https://api.github.com/repos/nickqiaoo/operon-agents/actions/jobs/…/logs" },
  },
]

export const MOCK_GRANTS: StandingGrant[] = [
  { id: "g1", title: "Read mail in Gmail", icon: "mail", grantedAt: ago(6 * 24 * hour) },
]

export const MOCK_SCHEDULES: ScheduleItem[] = [
  {
    id: "heartbeat",
    name: "Heartbeat",
    cadence: "Every 30 minutes",
    nextRunAt: now + 22 * min,
    enabled: true,
    builtin: "heartbeat",
    runs: [
      { id: "r1", at: ago(8 * min), outcome: "silent" },
      { id: "r2", at: ago(38 * min), outcome: "found", note: "HSBC security email" },
      { id: "r3", at: ago(68 * min), outcome: "silent" },
      { id: "r4", at: ago(98 * min), outcome: "failed", note: "Gmail timed out" },
      { id: "r5", at: ago(128 * min), outcome: "silent" },
    ],
  },
  {
    id: "brief",
    name: "Morning brief",
    cadence: "Daily at 08:40",
    nextRunAt: now + 11 * hour,
    enabled: true,
    runs: [{ id: "r1", at: ago(13 * hour), outcome: "found", note: "5 items" }],
  },
  {
    id: "podcast",
    name: "Daily tech & US stocks podcast",
    cadence: "Daily at 08:40",
    nextRunAt: now + 11 * hour,
    enabled: true,
    runs: [{ id: "r1", at: ago(28 * hour), outcome: "found", note: "10-minute episode" }],
  },
  {
    id: "tour",
    name: "Agentic feature tour",
    cadence: "Once, Sep 30 at 13:13",
    nextRunAt: now + 16 * hour,
    enabled: true,
    runs: [],
  },
]
