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

/** The checks in heartbeat.md: its "## …" sections, by heading. The commented-out example doesn't count. */
export function heartbeatChecks(heartbeat: string): string[] {
  return heartbeat
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .split('\n')
    .map((l) => /^##\s+(\S.*)$/.exec(l.trim())?.[1]?.trim())
    .filter((h): h is string => Boolean(h))
}

export interface ProfileFile {
  name: ProfileFileName
  content: string
  updatedAt: number
  updatedBy: 'assistant' | 'user'
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

export interface AssistantState {
  messages: AssistantMessage[]
  /** Whether older messages exist before `messages[0]`. */
  hasMore: boolean
  activities: Activity[]
  /** Newest first. */
  audit: AuditRecord[]
  files: ProfileFile[]
  config: AssistantConfig
  /** Heartbeat first. */
  schedules: AssistantSchedule[]
  /** The main agent is producing a reply right now. */
  typing: boolean
  /** Why the assistant cannot run, e.g. no model configured. */
  blocker?: string
  blockerReason?: AssistantBlockerReason
}

/** Live updates on `/api/assistant/stream`. */
export type AssistantEvent =
  | { type: 'message'; message: AssistantMessage }
  | { type: 'activity'; activity: Activity }
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
