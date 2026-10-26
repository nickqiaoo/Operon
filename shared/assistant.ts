/**
 * Wire types for the personal assistant (docs/assistant/design.md), shared by the
 * server (`/api/assistant`) and the desktop UI.
 */

/** What started an assistant message the user did not directly ask for. */
export type AssistantTrigger =
  | { kind: 'heartbeat' }
  | { kind: 'schedule'; name: string }
  | { kind: 'worker'; activityId: string }
  | { kind: 'coding'; activityId: string }

/** A file the user sent with a message. */
export interface AssistantAttachment {
  /** `/api/attachments/<sha256>`: the app's content-addressed store, same as chats use. */
  url: string
  mediaType: string
  filename?: string
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  /** User messages only. */
  attachments?: AssistantAttachment[]
  /** Set on messages the assistant sent on its own (a worker finishing, a heartbeat…). */
  trigger?: AssistantTrigger
  /** The worker this message is about — the UI links it to the Activity entry. */
  activityId?: string
  /** Lines the main agent wrote to memory.md while producing this message. */
  remembered?: string[]
  /** A worker is blocked on a permission decision; the thread renders it as a card. */
  approval?: AssistantApproval
}

export type ApprovalIcon = 'globe' | 'app' | 'file' | 'terminal' | 'tool'

/**
 * What became of a card. `expired` = the worker went away before anyone answered.
 * `always_allowed` only appears on cards from before standing grants were removed.
 */
export type ApprovalDecision = 'allowed_once' | 'always_allowed' | 'denied' | 'expired'

export interface AssistantApproval {
  id: string
  /** e.g. "Browser Use · Access https://x.com". */
  title: string
  /** Why the worker needs it — its step label, or the request's own wording. */
  detail: string
  icon: ApprovalIcon
  args?: Record<string, unknown>
  /** The worker that is waiting. */
  activityId?: string
  /** Unset while waiting on the user. */
  decision?: ApprovalDecision
}

/** One permission decision, by the user or made automatically. */
export interface AuditRecord {
  id: string
  title: string
  detail: string
  icon: ApprovalIcon
  decision: 'allowed_once' | 'always_allowed' | 'auto_allowed' | 'denied'
  at: number
  args?: Record<string, unknown>
  activityId?: string
}

export type ActivityStatus = 'running' | 'waiting' | 'done' | 'partial' | 'failed' | 'stopped'

export interface ActivityStep {
  /** The tool call id. */
  id: string
  /** What the call does, read off the call itself (its description, command or path). */
  label: string
  status: 'running' | 'done' | 'failed'
  tool: string
  args?: Record<string, unknown>
  /** What the tool returned (or the error), as text, truncated. */
  result?: string
  at: number
}

export interface Activity {
  id: string
  /** `aw-<id>`; the agent session it ran in is kept by the server. */
  taskId: string
  title: string
  /** One-line result, or the current state while running. */
  summary: string
  status: ActivityStatus
  startedAt: number
  finishedAt?: number
  /** Longer write-up for the drawer. */
  report?: string
  steps: ActivityStep[]
  source?: 'heartbeat' | 'schedule'
  /**
   * Who did it. Unset: a worker on a task. `main`: the main agent itself, in the conversation —
   * a turn where it changed something (memory, its files, a schedule). It can't be followed up
   * or stopped; there is no task behind it. `coding`: a coding agent in one of the user's
   * workspaces (`coding` says which); its work is in that conversation, not in `steps`.
   */
  agent?: 'main' | 'coding'
  coding?: ActivityCoding
}

/**
 * An activity without its run: what lists, the thread's cards and the live stream carry. The
 * steps (every call's arguments and result) and the write-up can run to megabytes, so they come
 * only with the activity itself, when it is opened (`GET /api/assistant/activities/:id`).
 */
export type ActivitySummary = Omit<Activity, 'steps' | 'report'>

export function activitySummaryOf(activity: Activity): ActivitySummary {
  const { steps: _steps, report: _report, ...summary } = activity
  return summary
}

/** A coding agent's conversation the assistant started in one of the user's workspaces. */
export interface ActivityCoding {
  chatId: number
  workspaceId: number
  workspaceName: string
  projectName?: string
  branch?: string
  /** `codex`, `claude-code`, … */
  providerId: string
  /** The model the user chose; `default` = the agent's own. */
  model: string
  /** Reasoning effort the user chose; unset = the agent's own. */
  effort?: string
  /** What the conversation is asking the user, while the Activity is `waiting`. */
  waitingFor?: string
  /**
   * The requests themselves, so the card answers them in place (POST /ai/permission-response
   * with `chatId`): a tool to allow, a question (`input.questions`), a plan (`input.plan`).
   */
  pending?: CodingPendingInput[]
  /** Uncommitted changes in the workspace when the last turn finished. */
  diffStat?: { files: number; additions: number; deletions: number }
}

/** One thing a coding agent's conversation is blocked on until the user answers. */
export interface CodingPendingInput {
  approvalId: string
  toolName: string
  /** One line of what is asked. */
  preview?: string
  /** The asking tool's full input. */
  input?: unknown
}

/** `taskId` of a coding agent's activity: the conversation it runs in. */
export const CODING_ACTIVITY_TASK_PREFIX = 'ac-'

/** `taskId` of a main-agent activity, which is how storage tells it from a worker's. */
export const MAIN_ACTIVITY_TASK_PREFIX = 'am-'

export type ProfileFileName = 'identity' | 'soul' | 'memory' | 'heartbeat'

/**
 * The heartbeat's own section of heartbeat.md, kept at its end: what the user has been told and is
 * still so, in its own words, plus what waits for quiet hours to end. Not a check. Only the heading
 * is read here; what is under it is the heartbeat's to write and to read.
 */
export const HEARTBEAT_TOLD_HEADING = 'Already told'

const TOLD_HEADING_RE = /^##\s+already told\b/i

/** The checks in heartbeat.md: its "## …" sections, by heading. The commented-out example and the heartbeat's own "Already told" don't count. */
export function heartbeatChecks(heartbeat: string): string[] {
  return heartbeat
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .split('\n')
    .map((l) => /^##\s+(\S.*)$/.exec(l.trim())?.[1]?.trim())
    .filter((h): h is string => Boolean(h) && !TOLD_HEADING_RE.test(`## ${h}`))
}

/**
 * Where the "Already told" sections sit in heartbeat.md's lines, each from its heading up to the next
 * "## " or the end. Normally one; a `told` handed back with its own heading used to leave a second,
 * and every one after it stacked up below.
 */
function toldRanges(lines: string[]): [number, number][] {
  const ranges: [number, number][] = []
  for (let start = 0; start < lines.length; start++) {
    if (!TOLD_HEADING_RE.test(lines[start]!.trim())) continue
    let end = start + 1
    while (end < lines.length && !/^##\s/.test(lines[end]!.trim())) end++
    ranges.push([start, end])
    start = end - 1
  }
  return ranges
}

/** What is under "## Already told" now, without the heading (all such sections, when there are several); empty when there is none. */
export function heartbeatTold(heartbeat: string): string {
  const lines = heartbeat.split('\n')
  return toldRanges(lines)
    .map(([start, end]) => lines.slice(start + 1, end).join('\n').trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * heartbeat.md with its "Already told" section replaced by `told` (added at the end when missing;
 * dropped when `told` is empty). Any further "Already told" sections go, and so does the heading when
 * `told` carries it, so there is only ever one. The checklist above is left as it is.
 */
export function withHeartbeatTold(heartbeat: string, told: string): string {
  const lines = heartbeat.split('\n')
  const ranges = toldRanges(lines)
  const body = told
    .split('\n')
    .filter((l) => !TOLD_HEADING_RE.test(l.trim()))
    .join('\n')
    .trim()
  const section = body ? [`## ${HEARTBEAT_TOLD_HEADING}`, '', body, ''] : []
  for (const [start, end] of ranges.slice(1).reverse()) lines.splice(start, end - start)
  const first = ranges[0]
  if (first) lines.splice(first[0], first[1] - first[0], ...section)
  else if (body) lines.push(...(lines.at(-1)?.trim() ? [''] : []), ...section)
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

export interface ProfileFile {
  name: ProfileFileName
  content: string
  updatedAt: number
  updatedBy: 'assistant' | 'user'
}

/** A file the assistant made for the user, in its outputs folder (`~/.operon/assistant/workspace/outputs`). */
export interface AssistantWorkspaceFile {
  /** Absolute. */
  path: string
  /** From the outputs folder, `/`-separated. */
  relativePath: string
  size: number
  updatedAt: number
}

/**
 * Which agent runs a part of the assistant: `custom` (operon), `claude-code`, `codex` or
 * `opencode`, and a model of that agent's. Empty `modelId`: the agent's own default (for operon,
 * the first model set up in AI Providers).
 */
export interface AssistantAgentChoice {
  providerId: string
  modelId: string
}

export interface AssistantConfig {
  /** The main agent: talks, remembers, hands out work. A fast model is enough. */
  main: AssistantAgentChoice
  /** Workers: do the work. */
  worker: AssistantAgentChoice
  /** Heartbeat and scheduled runs, nobody watching. Null: same as workers. */
  background: AssistantAgentChoice | null
  /** Quiet hours, `HH:MM` local time: the heartbeat only speaks up for something urgent. */
  quietStart: string
  quietEnd: string
}

/**
 * English the server writes into stored records, which the UI recognizes and words in the
 * user's language. Stored, so the text is a contract: changing it orphans old rows.
 */
/** The note on a heartbeat run that had nothing to look at. */
export const NOTHING_TO_CHECK_NOTE = 'Nothing to check'
/** Audit detail of a step skipped because nobody was watching; the rest of the detail follows. */
export const UNATTENDED_SKIP_PREFIX = 'Skipped while running unattended: '
/** Summary of a run cut off by an app restart. */
export const INTERRUPTED_SUMMARY = 'Interrupted when the app restarted'
/** Summary of a run that is still going. */
export const WORKING_SUMMARY = 'Working…'
/** Summary of a coding agent's activity blocked on the user; the rest says on what. The UI translates the prefix. */
export const WAITING_SUMMARY_PREFIX = 'Waiting for you: '
/** Start of the message the assistant posts when its own turn failed; the error follows. */
export const TURN_ERROR_PREFIX = 'Something went wrong on my side: '

/** Why the assistant can't run, as a code the UI words itself (`blocker` keeps the English). */
export type AssistantBlockerReason =
  | { kind: 'unknown-agent'; agent: string }
  | { kind: 'not-installed'; agent: string }
  | { kind: 'no-model' }

/** `partial`: the heartbeat ran but could not check some services (the note says which). */
export type ScheduleRunOutcome = 'silent' | 'found' | 'partial' | 'failed'

/** One run of the heartbeat or a scheduled task. */
export interface AssistantScheduleRun {
  id: string
  scheduleId: number
  at: number
  outcome: ScheduleRunOutcome
  /** What it found, or why it failed. */
  note?: string
  /** The Activity a run that found something (or a scheduled task) produced. */
  activityId?: string
}

/** The heartbeat, or a task the assistant set up to run at set times. */
export interface AssistantSchedule {
  id: number
  name: string
  /**
   * Heartbeat only: plugins it would look at but that aren't signed in, so it skips them. A
   * standing state shown on the heartbeat, not a failure of each run.
   */
  notConnected?: Array<{ pluginId: string; name: string }>
  /** What the worker is told on each run. Empty for the heartbeat, which works through heartbeat.md and memory.md's "In progress". */
  prompt: string
  /** e.g. "Every 30 minutes", "Weekdays at 08:40". */
  cadence: string
  /** `HH:MM`: the run time, or where an every-N-minutes window starts. */
  time: string
  /** 0 = Sunday. */
  days: number[]
  everyMinutes?: number
  /** `HH:MM`: where an every-N-minutes window ends. */
  until?: string
  nextRunAt?: number
  enabled: boolean
  /** The heartbeat: always on, cannot be deleted. */
  builtin?: 'heartbeat'
  /** Newest first. */
  runs: AssistantScheduleRun[]
}

/**
 * What opening the assistant loads: the thread and what it shows. The side panel's lists
 * (activities, audit, schedules) each come from their own endpoint when that tab is opened.
 */
export interface AssistantState {
  messages: AssistantMessage[]
  /** Whether older messages exist before `messages[0]`. */
  hasMore: boolean
  /** Not the Activity list: the ones still at work (the header's status) and the ones `messages` point at (coding agents' cards). */
  activities: ActivitySummary[]
  files: ProfileFile[]
  config: AssistantConfig
  /** The main agent is producing a reply right now. */
  typing: boolean
  /** Why the assistant cannot run, e.g. no model configured. */
  blocker?: string
  blockerReason?: AssistantBlockerReason
}

/** Live updates on `/api/assistant/stream`. */
export type AssistantEvent =
  | { type: 'message'; message: AssistantMessage }
  /** Its steps are not in it: an open activity fetches them again. */
  | { type: 'activity'; activity: ActivitySummary }
  | { type: 'file'; file: ProfileFile }
  | { type: 'typing'; typing: boolean }
  | { type: 'config'; config: AssistantConfig }
  | { type: 'audit'; record: AuditRecord }
  | { type: 'schedules'; schedules: AssistantSchedule[] }
  /** It changed the projects (made a workspace): the sidebar's tree is stale. */
  | { type: 'projects' }

/**
 * Name and how it addresses the user, from identity.md's frontmatter. Empty values read as
 * unset — an identity without a name is what puts the assistant into onboarding.
 */
export function parseIdentity(content: string): { name?: string; userName?: string } {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? ''
  // `[ \t]*`, not `\s*`: an empty `name:` must not swallow the next line as its value.
  const field = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter)?.[1]?.trim() || undefined
  return { name: field('name'), userName: field('user_name') }
}
