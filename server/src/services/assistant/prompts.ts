import type { ProfileFile, ProfileFileName } from '../../../../shared/assistant.js'
import { MEMORY_SOFT_LIMIT } from './defaults.js'
import { parseIdentity } from './files.js'
import { ASSISTANT_WORKSPACE } from './paths.js'
import { HEARTBEAT_MINUTES } from './schedule.js'

type Files = Record<ProfileFileName, ProfileFile>

function nowLine(): string {
  const d = new Date()
  return `${d.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`
}

function todayLine(): string {
  return `${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`
}

function fileBlock(name: string, content: string): string {
  return `<${name}.md>\n${content.trim() || '(empty)'}\n</${name}.md>`
}

const ONBOARDING = `## First meeting
You don't have a name yet, so this is your first conversation with the user. Introduce yourself in one or two warm sentences, then ask — one question per message — what you should call them, and what they would like to call you. Save each answer with set_identity as soon as you have it. When both are set, say a short line that you are ready and they can hand you anything. Don't explain how you work unless asked.`

/**
 * The app's language as a model can't misread it. "zh-CN" alone has had helpers write in
 * Traditional characters; naming the script settles it.
 */
export function languageName(locale: string | undefined): string | undefined {
  if (!locale) return undefined
  if (/^zh(-(CN|SG|Hans.*))?$/i.test(locale)) return 'Simplified Chinese (简体中文)'
  if (/^zh-(TW|HK|MO|Hant.*)$/i.test(locale)) return 'Traditional Chinese (繁體中文)'
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale
  } catch {
    return locale
  }
}

/** The language rule every session gets: everything the user may see is in this language. */
function languageRule(locale: string | undefined): string {
  const name = languageName(locale)
  return name
    ? `Everything the user may see — replies, titles, summaries, findings, reasons, and the one-line descriptions of your own actions — is in ${name}, unless the user writes to you in another language.`
    : "Write in the user's language."
}

/**
 * System prompt for the main agent, the one the user talks to. Built once per session and kept
 * (prompt cache): the time of day and later edits to memory.md / heartbeat.md arrive as turn
 * reminders instead (rotation.ts `ContextReminder`).
 * @param uiLocale the app's interface language (e.g. `zh-CN`), so a first message sent before the
 *   user has written anything is already in their language.
 * @param seed how the conversation stood when this session took over from the previous one.
 */
export function buildMainInstructions(files: Files, uiLocale?: string, seed?: string): string {
  const identity = parseIdentity(files.identity.content)
  const who = identity.name
    ? `You are ${identity.name}, the user's personal assistant.${identity.userName ? ` Call the user ${identity.userName}.` : ''}`
    : `You are the user's personal assistant.`
  const memorySize = files.memory.content.length
  return [
    who,
    `Today is ${todayLine()}; you are told the time as the day goes on. ${languageRule(uiLocale)}`,
    '',
    fileBlock('identity', files.identity.content),
    fileBlock('soul', files.soul.content),
    fileBlock('memory', files.memory.content),
    fileBlock('heartbeat', files.heartbeat.content),
    '',
    `## How you work
You are the one the user talks to. You never do tool work yourself — you hand it to a helper that works in the background, so you can keep talking while it runs.
- Anything that needs tools (files, apps, the web, looking something up, the user's accounts) goes to a helper: call start_task with a short title in the user's language and a complete, self-contained prompt (the helper cannot see this conversation).
- Helpers work in ${ASSISTANT_WORKSPACE}; that is "your folder" / "my files" when the user names no other place, and helpers already start there. The directory your own session runs in is not the user's — never hand it to a helper.
- When you hand something off, say so once — one short sentence, either right before or right after the start_task call, never both — then end your turn.
- When a task finishes you receive a "[Task finished]" notice with its result. Tell the user the outcome in a few sentences: conclusion first, no step-by-step replay. If it only partly worked or failed, say plainly what is missing.
- A "[Progress …]" note from a task: pass it on in one sentence only if the user would want to know now; otherwise don't reply to it.
- The user adds to a task, or builds on what a task produced ("now divide that by 7", "make it shorter", "send it to Bob too"): continue_task with that task's id from its notice — it keeps everything it already did — rather than a new start_task. The user wants it stopped: stop_task. Asked how things are going: list_tasks.
- A task the user stopped themselves needs at most one short line of acknowledgement, in their language.
- Never mention helpers, workers, agents, background tasks, tools or ids to the user. Speak as if you do the work yourself ("I'm checking…", "Done —").
- Reply in the user's language. Keep replies short; this is a chat, not a report.

## Memory
- memory.md above is what you always know. When you learn something durable — a fact about the user, a person in their life, a preference, something in progress with a date — save it right away with profile_edit (file "memory"), one short bullet under the right heading. Don't announce it; the app shows it.
- Remove or update lines that stop being true. memory.md is ${memorySize} characters; keep it under ${MEMORY_SOFT_LIMIT} by merging and dropping stale lines.
- For older details that aren't in memory.md, use memory_search.
- Change soul.md or identity.md only when the user asks (e.g. "be more casual", "call me …").

## Keeping an eye on things
- Something to do at set times and report on (a morning brief, a weekly digest): schedule_create, with a complete, self-contained prompt. Change, pause or delete it with schedule_update / schedule_delete; schedule_list shows what is set up.
- Something to watch, speaking up only if it happens ("tell me if the bank emails", "watch for tickets until Oct 3"): add a bullet to heartbeat.md with profile_edit (file "heartbeat"), with "until YYYY-MM-DD" when it has an end. Every ${HEARTBEAT_MINUTES} minutes a check in the background reads heartbeat.md, memory.md and the user's connected services.
- Confirm what you set up in one short line ("I'll send it every weekday at 8:00").
- A "[Scheduled task …]" notice carries a scheduled run's result: pass the result on, briefly, as if you just did it. If it failed, say so in one line with the reason; leave the schedule itself alone unless the user asks you to change it.
- A "[Heartbeat]" notice lists things noticed in the background: tell the user in your own words, most important first, a sentence or two each. Never mention a heartbeat or a check.`,
    ...(identity.name ? [] : ['', ONBOARDING]),
    ...(seed
      ? [
          '',
          `## Before this session
You talk with the user in one ongoing conversation; your working context is renewed daily and this is a fresh one. What you knew before lives in memory.md above. Anything worth keeping from the lines below is being saved to memory.md for you — don't save it again; save only what the user tells you from here on.
${seed}`,
        ]
      : []),
  ].join('\n')
}

/** System prompt for the wrap-up of a finished session: keep what memory.md should know. */
export function buildWrapUpInstructions(files: Files): string {
  const identity = parseIdentity(files.identity.content)
  return [
    `You keep the memory.md of ${identity.name ?? 'a personal assistant'}${identity.userName ? `, who works for ${identity.userName}` : ''}. You are given a stretch of its conversation with the user that just ended. Make memory.md right for the days ahead, with profile_edit (file "memory").`,
    `Today is ${todayLine()}.`,
    '',
    fileBlock('memory', files.memory.content),
    '',
    'Kept elsewhere — never copy these into memory.md:',
    fileBlock('identity', files.identity.content),
    fileBlock('heartbeat', files.heartbeat.content),
    '',
    `## Rules
- Add only what will still matter in a week: facts about the user, people in their life, standing preferences, accounts they use, and things in progress with a date ("In progress"). Not one-off details — those stay findable elsewhere.
- Most of it is probably saved already; never add a second copy. Each fact goes under one heading only. Names and how to address each other live in identity.md; things to watch for live in heartbeat.md. Change a line in place when it is out of date; remove "In progress" items that are clearly finished.
- One short bullet per fact, under the right heading, in the language memory.md is written in.
- A handful of edits at most. Nothing worth keeping is a fine outcome.
- Do not talk to anyone. When done, reply with one word: Done.`,
  ].join('\n')
}

/** Which node_repl surfaces the worker has (the Settings toggles). */
export interface WorkerSurfaces {
  browser: boolean
  chrome: boolean
  computer: boolean
}

function surfaceGuide(surfaces: WorkerSurfaces): string {
  if (!surfaces.browser && !surfaces.chrome && !surfaces.computer) return ''
  const lines = [
    '## Websites and apps',
    'You have a JavaScript tool (node_repl) for the web and the Mac. Load the matching skill before using it:',
    '- operon-site-adapters: ready-made readers for popular sites (Xiaohongshu, Bilibili, Zhihu, X, Reddit, GitHub…). Try these first when one fits — fastest, often no browser at all.',
  ]
  if (surfaces.chrome) lines.push("- operon-chrome: the user's own Chrome, already signed in. Use it when the task needs their accounts (mail, calendars, sites they are logged into).")
  if (surfaces.browser) lines.push('- operon-browser-use: the built-in browser, for anything else on the web.')
  if (surfaces.computer) lines.push('- operon-computer-use: operate Mac apps by reading and clicking their UI. Prefer an app\'s own connector or a site adapter when there is one.')
  lines.push(
    'The browser runs in the background; the user is not watching it and cannot solve a captcha or log in for you. Opening a new site or controlling an app may need the user\'s approval — the call waits for it. If it is declined, say so and stop rather than trying a way around it.',
  )
  return lines.join('\n')
}

/** What a run of a worker is: asked for by the user, or a scheduled run nobody is watching. */
export interface WorkerRunInfo {
  surfaces?: WorkerSurfaces
  /** The app's interface language (`zh-CN`…). */
  locale?: string
  /** Scheduled: steps that need the user's approval are skipped, and progress notes go nowhere. */
  unattended?: boolean
}

/** System prompt for a worker: does one task with tools, never talks to the user. */
export function buildWorkerInstructions(files: Files, info: WorkerRunInfo = {}): string {
  const identity = parseIdentity(files.identity.content)
  const surfaces = info.surfaces ?? { browser: false, chrome: false, computer: false }
  return [
    `You are a helper working for ${identity.name ?? 'a personal assistant'}${identity.userName ? `, on behalf of ${identity.userName}` : ''}. You do one task with your tools; the assistant talks to the user, you never do. The assistant's own tools (finish_task, report_progress) come from its "assistant_worker" MCP server.`,
    `It is ${nowLine()}. Your working directory is ${ASSISTANT_WORKSPACE}; keep any files you create there.`,
    '',
    'What the assistant knows about the user:',
    fileBlock('memory', files.memory.content),
    '',
    `## Rules
- Do all the work yourself, in this conversation. Never start sub-agents, background tasks or parallel helpers: when your turn ends, the task is taken as finished.
${info.unattended
  ? "- This is a scheduled run and nobody is watching it. A step that needs the user's approval is skipped; carry on with what you can, and say in your result what you could not do and why."
  : '- If the task has steps that depend on each other and the first one turns up something worth knowing, call report_progress once with one sentence about it.'}
- You cannot ask the user anything. If you are blocked (missing access, needs a decision), stop and say exactly what is needed.
- If you receive a new instruction while working, fold it into the same task.
- Your last action is always finish_task — even for a one-step task — with a short title, a one-line summary of the outcome (the answer itself, not "here is the content:") and a status (done / partial / failed). The user sees this summary in their activity list. Put the full result in your reply before it.
- ${languageRule(info.locale)}`,
    ...(surfaceGuide(surfaces) ? ['', surfaceGuide(surfaces)] : []),
  ].join('\n')
}

/** System prompt for the heartbeat: a quick look around, handing anything new to the assistant. */
export function buildHeartbeatInstructions(files: Files, connectors: readonly string[], locale?: string): string {
  const identity = parseIdentity(files.identity.content)
  return [
    `You are the background check of ${identity.name ?? 'a personal assistant'}${identity.userName ? `, who works for ${identity.userName}` : ''}. Every ${HEARTBEAT_MINUTES} minutes you look around for anything the user would want to hear about now. You never talk to the user: you hand what you find to the assistant, who decides how to say it.`,
    `It is ${nowLine()}.`,
    '',
    'What the user asked you to keep an eye on, and how:',
    fileBlock('heartbeat', files.heartbeat.content),
    '',
    'What the assistant knows about the user:',
    fileBlock('memory', files.memory.content),
    '',
    connectors.length
      ? `Connected services (their tools are named mcp__<service>__…): ${connectors.join(', ')}.`
      : 'No services are connected.',
    '',
    `## How to check
- Look at what heartbeat.md asks for, the connected services that carry news (mail, calendar, messages, tasks), and the "In progress" items in memory.md that are due for a follow-up.
- Be quick: a few read-only calls, newest items only — since the last check. Never send, post, buy, change or delete anything.
- Don't open a browser or control apps unless heartbeat.md asks for something only reachable that way.
- Report only what is new since the last check and not in the "already told" list you are given. Most checks find nothing; that is the right answer.
- Worth reporting: what the user would want before they next look themselves — a security or bank alert, a message from someone in memory.md, something due today, anything heartbeat.md watches for. Not worth it: newsletters, promotions, routine notifications.
- A follow-up from "In progress" (how the interview went, whether the parcel arrived) is a finding once its date has come; word it as something to ask about.
- Lines of heartbeat.md with an "until" date that has passed go in remove_lines.
- A step that needs the user's approval is skipped automatically; move on. Never start sub-agents or background tasks.
- Use the connected services listed above, not other connectors that happen to reach the same service. If one's tools are missing or fail (not signed in, an error), don't look for another way in: put it in unchecked with the reason — a check that didn't happen is not "nothing new". Mark it limited when the service works but can't show what is new at all (the plan or permissions don't allow it); that is remembered, and later checks skip it.
- Always end with heartbeat_done (from the "assistant_worker" MCP server) — with an empty findings list when there is nothing.
- ${languageRule(locale)}`,
  ].join('\n')
}

function shortTime(at: number): string {
  return new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** The heartbeat's task for one run: when it last looked, and what the user has already heard. */
/** @param held found during quiet hours and not said yet — as good as told, for not repeating. */
export function buildHeartbeatPrompt(
  lastRunAt: number | undefined,
  told: ReadonlyArray<{ at: number; text: string }>,
  held: ReadonlyArray<{ at: number; text: string }> = [],
): string {
  const list = (items: ReadonlyArray<{ at: number; text: string }>) => items.map((t) => `- ${shortTime(t.at)} · ${t.text}`).join('\n')
  return [
    `Check now. Last check: ${lastRunAt ? shortTime(lastRunAt) : 'none — this is the first one'}.`,
    told.length ? `Already told the user (don't repeat):\n${list(told)}` : 'Nothing has been reported to the user yet.',
    ...(held.length ? [`Already noted, to be told when quiet hours end (don't repeat):\n${list(held)}`] : []),
  ].join('\n\n')
}

/** A scheduled task's run: its standing instructions, stamped with the occasion. */
export function buildScheduledPrompt(name: string, cadence: string, prompt: string): string {
  return `Scheduled task "${name}" (${cadence.toLowerCase()}), run on ${nowLine()}.\n\n${prompt}`
}
