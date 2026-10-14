import { z } from 'zod'
import type { AssistantSchedule, ProfileFileName } from '../../../../shared/assistant.js'
import { MemoryService } from '../memory/index.js'
import { execMemorySearch } from '../memory/operations.js'
import { readProfileFile, writeProfileFile } from './files.js'
import type { AssistantCaller, AssistantRole } from './node-repl-bridge.js'
import type { OperonState } from './operon-state.js'
import type { OperonActions } from './operon-actions.js'
import type { ScheduleInput } from './schedule.js'

/**
 * The assistant's own tools — the main agent's and a worker's — whatever agent runs
 * the session. They are served over MCP by the app (routes/assistant-mcp.ts), so Codex, Claude
 * Code, OpenCode and operon all see the same ones; which session may call which is decided by
 * the caller's role, not by what a client happened to list.
 */

/** A worker as the main agent sees it when listing. */
export interface TaskListing {
  id: string
  title: string
  status: string
  summary: string
}

/** What a worker hands in at the end of a task. */
export interface FinishArgs {
  title: string
  summary: string
  status: 'done' | 'partial' | 'failed'
}

/** What the heartbeat hands in at the end of a check. */
export interface HeartbeatArgs {
  findings: Array<{ text: string; urgent: boolean }>
  /** Checklist sections (by heading) that could not be done this time, and why. */
  unchecked?: Array<{ check: string; reason: string }>
}

/** The schedule tools' view of the assistant (schedule.ts does the work). */
export interface ScheduleToolHost {
  list(): AssistantSchedule[]
  create(input: ScheduleInput): AssistantSchedule
  update(id: number, patch: Partial<ScheduleInput> & { enabled?: boolean }): AssistantSchedule
  remove(id: number): boolean
}

/** What the tools need from the running assistant. */
export interface AssistantToolHost {
  /** Start a worker on a task; returns its id. */
  startTask(input: { title: string; prompt: string }): Promise<string>
  /** Add to a running task, or pick a finished one back up. */
  continueTask(id: string, message: string): Promise<'delivered' | 'continued' | 'missing'>
  stopTask(id: string): Promise<boolean>
  listTasks(): TaskListing[]
  /** A milestone worker `activityId` wants passed on. */
  progress(activityId: string, text: string): void
  /** Worker `activityId` handed in its result. False: no such running worker. */
  finish(activityId: string, args: FinishArgs): boolean
  /** The heartbeat run `activityId` handed in what it found. False: not a running heartbeat. */
  heartbeatDone(activityId: string, args: HeartbeatArgs): boolean
  /** A definition file changed through a tool, by `role`. */
  onFileWritten(name: ProfileFileName, role: AssistantRole): void
  schedules: ScheduleToolHost
  /** The projects, workspaces, conversations and board in the rest of the app. */
  operon: OperonState
  /** Changes to workspaces and the board, on the user's behalf. */
  actions: OperonActions
  coding: CodingToolHost
}

/** Coding agents in the user's workspaces (coding.ts does the work). Errors are thrown. */
export interface CodingToolHost {
  /** The agents the user can pick and their models, as JSON. */
  models(agentTypes: string[], query: string | undefined): Promise<string>
  start(input: { workspaceId: number; title: string; prompt: string; providerId: string; model: string; effort?: string }): Promise<string>
  /** `title`: a new name for its card, when this is a new piece of work. */
  send(chatId: number, message: string, title?: string): string
  status(chatId: number): string
  stop(chatId: number): string
}

export type ToolResult = string | { text: string; isError: true }

export interface AssistantTool {
  name: string
  description: string
  parameters: z.ZodObject<z.ZodRawShape>
  /** Which kinds of session may call it. */
  roles: readonly AssistantRole[]
  run(args: never, caller: AssistantCaller, host: AssistantToolHost): ToolResult | Promise<ToolResult>
}

/** A typed tool definition; the cast is what lets one list hold them all. */
function defineTool<S extends z.ZodRawShape>(spec: {
  name: string
  description: string
  parameters: z.ZodObject<S>
  roles: readonly AssistantRole[]
  run(args: z.infer<z.ZodObject<S>>, caller: AssistantCaller, host: AssistantToolHost): ToolResult | Promise<ToolResult>
}): AssistantTool {
  return spec as unknown as AssistantTool
}

function failure(text: string): ToolResult {
  return { text, isError: true }
}

// ---------------------------------------------------------------------------
// The main agent's tools. Its memory (memory.md, day notes) is plain files it edits itself.
// ---------------------------------------------------------------------------

/**
 * The main agent's changes show in the user's Activity log as steps, named by this (stepLabel
 * reads `description` first) — the tools' other arguments say how, not what for.
 */
const changeDescription = z
  .string()
  .optional()
  .describe("What this change is, in a few words in the user's language; the user sees it in their activity log. Always fill it in.")

/** identity.md's frontmatter, field by field — no text matching on `name:` vs `user_name:`. */
const setIdentity = defineTool({
  name: 'set_identity',
  description: 'Set your own name and/or what you call the user, in identity.md.',
  parameters: z.object({
    name: z.string().optional().describe('Your name'),
    user_name: z.string().optional().describe('What you call the user'),
    description: changeDescription,
  }),
  roles: ['main'],
  run: ({ name, user_name }, caller, host) => {
    let content = readProfileFile('identity').content
    if (!/^---\n[\s\S]*?\n---/.test(content)) content = `---\n---\n\n${content}`
    const setField = (text: string, key: string, value: string) => {
      const line = new RegExp(`^${key}:.*$`, 'm')
      return line.test(text) ? text.replace(line, `${key}: ${value}`) : text.replace(/^---\n/, `---\n${key}: ${value}\n`)
    }
    if (name?.trim()) content = setField(content, 'name', name.trim())
    if (user_name?.trim()) content = setField(content, 'user_name', user_name.trim())
    writeProfileFile('identity', content, 'assistant')
    host.onFileWritten('identity', caller.role)
    return 'Saved identity.md.'
  },
})

const memorySearch = defineTool({
  name: 'memory_search',
  description: "Search older memories about the user that aren't in memory.md (past events, details, people).",
  parameters: z.object({
    query: z.string(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  roles: ['main'],
  run: async ({ query, limit }) => {
    let engine
    try {
      engine = MemoryService.getInstance().getEngine()
    } catch {
      return 'Memory search is not available.'
    }
    return execMemorySearch(engine, { query, limit: limit ?? 8 })
  },
})

const startTask = defineTool({
  name: 'start_task',
  description:
    'Hand a task to a helper that works in the background with tools (files, apps, the web, connected accounts). Returns at once with the task id; you get a notice when it finishes.',
  parameters: z.object({
    title: z.string().describe("3–8 words in the user's language; the user sees it as the task title"),
    prompt: z.string().describe('Complete, self-contained instructions — the helper cannot see this conversation'),
  }),
  roles: ['main'],
  run: async ({ title, prompt }, _caller, host) => `Started task ${await host.startTask({ title, prompt })}.`,
})

const continueTask = defineTool({
  name: 'continue_task',
  description:
    'Send more instructions to a task. A running task folds them in; a finished one picks up where it left off, with everything it already did still in its context.',
  parameters: z.object({ task_id: z.string(), message: z.string() }),
  roles: ['main'],
  run: async ({ task_id, message }, _caller, host) => {
    const result = await host.continueTask(task_id, message)
    if (result === 'missing') return failure(`There is no task ${task_id}.`)
    return result === 'delivered' ? 'Delivered to the running task.' : 'The task is working on it again.'
  },
})

const stopTask = defineTool({
  name: 'stop_task',
  description: 'Stop a running task.',
  parameters: z.object({ task_id: z.string() }),
  roles: ['main'],
  run: async ({ task_id }, _caller, host) => ((await host.stopTask(task_id)) ? 'Stopped.' : 'That task is not running.'),
})

const listTasks = defineTool({
  name: 'list_tasks',
  description: 'The most recent tasks with their status and one-line result — for when the user asks how things are going.',
  parameters: z.object({}),
  roles: ['main'],
  run: (_args, _caller, host) => {
    const tasks = host.listTasks()
    if (!tasks.length) return 'No tasks yet.'
    return tasks.map((t) => `- ${t.id} · ${t.status} · ${t.title} — ${t.summary}`).join('\n')
  },
})

// ---------------------------------------------------------------------------
// The user's coding work in the rest of the app (docs/assistant/operon-manager.md). Read-only and
// local, so the main agent looks these up itself rather than handing them to a helper.
// ---------------------------------------------------------------------------

const workspaceList = defineTool({
  name: 'workspace_list',
  description:
    "The user's projects and their workspaces (each a git worktree on its own branch), with how many conversations in each are running or waiting for the user. Start here when the user asks about their coding work.",
  parameters: z.object({}),
  roles: ['main'],
  run: (_args, _caller, host) => host.operon.workspaceList(),
})

const workspaceOverview = defineTool({
  name: 'workspace_overview',
  description:
    "One workspace in detail: its uncommitted changes, its recent conversations (agent, running / waiting / idle, the last reply of idle ones) and the project's open board tasks.",
  parameters: z.object({ workspace_id: z.number().int().describe('From workspace_list') }),
  roles: ['main'],
  run: ({ workspace_id }, _caller, host) => host.operon.workspaceOverview(workspace_id),
})

const waitingList = defineTool({
  name: 'waiting_list',
  description:
    'Every conversation in any workspace that is blocked on the user right now — an approval, a question or a plan to review — and what it is asking. Only the user can answer these, in that conversation.',
  parameters: z.object({}),
  roles: ['main'],
  run: (_args, _caller, host) => host.operon.waitingList(),
})

const workspaceCreate = defineTool({
  name: 'workspace_create',
  description:
    'A new workspace for a project: a new branch in its own worktree, shown in the sidebar. Only when the user wants one, or agreed to one because the work needs its own branch.',
  parameters: z.object({
    project_id: z.number().int().describe('From workspace_list'),
    name: z.string().describe('Short, e.g. "login-redirect"; it also names the branch'),
    base_branch: z.string().optional().describe("What the branch starts from; the repository's default branch if left out"),
    description: changeDescription,
  }),
  roles: ['main'],
  run: async ({ project_id, name, base_branch }, _caller, host) => {
    try {
      return await host.actions.createWorkspace({ projectId: project_id, name, ...(base_branch ? { base: base_branch } : {}) })
    } catch (error) {
      return failure(messageOf(error))
    }
  },
})

const projectAdd = defineTool({
  name: 'project_add',
  description:
    'Add a repository as a project, so its workspaces show in the sidebar: one already on disk, or cloned there first from clone_url. Only when the user asked, at the folder they agreed to.',
  parameters: z.object({
    path: z.string().describe('Full path of the repository folder (for a clone: where it goes; it must not exist yet)'),
    clone_url: z.string().optional().describe('https://, ssh:// or git@ URL to clone from'),
    name: z.string().optional().describe("Project name; the folder's name if left out"),
    description: changeDescription,
  }),
  roles: ['main'],
  run: async ({ path, clone_url, name }, _caller, host) => {
    try {
      return await host.actions.addProject({ path, ...(clone_url ? { cloneUrl: clone_url } : {}), ...(name ? { name } : {}) })
    } catch (error) {
      return failure(messageOf(error))
    }
  },
})

const githubPrs = defineTool({
  name: 'github_prs',
  description: "A project's GitHub pull requests: state, review, checks (failing ones named), branches. Uses the user's own gh login.",
  parameters: z.object({
    project_id: z.number().int().describe('From workspace_list'),
    state: z.enum(['open', 'closed', 'merged', 'all']).optional().describe('open if left out'),
  }),
  roles: ['main'],
  run: async ({ project_id, state }, _caller, host) => {
    try {
      return await host.actions.githubPrs(project_id, state)
    } catch (error) {
      return failure(messageOf(error))
    }
  },
})

const githubPr = defineTool({
  name: 'github_pr',
  description: 'One pull request: where it stands, its description and latest comments.',
  parameters: z.object({ project_id: z.number().int(), number: z.number().int() }),
  roles: ['main'],
  run: async ({ project_id, number }, _caller, host) => {
    try {
      return await host.actions.githubPr(project_id, number)
    } catch (error) {
      return failure(messageOf(error))
    }
  },
})

const githubPrCreate = defineTool({
  name: 'github_pr_create',
  description:
    "Open a pull request from a workspace's branch: commits what it has, pushes the branch, opens the PR with the user's gh login. This publishes the work — only when the user asked for a PR.",
  parameters: z.object({
    workspace_id: z.number().int().describe('From workspace_list; it must be on its own branch'),
    title: z.string().describe('Also the commit message for uncommitted changes'),
    body: z.string().optional().describe('What changed and why, in markdown'),
    base_branch: z.string().optional().describe("Defaults to the repository's default branch"),
    draft: z.boolean().optional(),
    description: changeDescription,
  }),
  roles: ['main'],
  run: async ({ workspace_id, title, body, base_branch, draft }, _caller, host) => {
    try {
      return await host.actions.githubPrCreate(workspace_id, {
        title,
        ...(body ? { body } : {}),
        ...(base_branch ? { base: base_branch } : {}),
        ...(draft != null ? { draft } : {}),
      })
    } catch (error) {
      return failure(messageOf(error))
    }
  },
})

const TASK_STATUS = z.enum(['todo', 'in_progress', 'in_review', 'done', 'cancelled'])
const projectId = z.number().int().describe('From workspace_list')
const taskNumber = z.number().int().describe('The task number, as in "#12"')

const boardList = defineTool({
  name: 'board_list',
  description: "A project's board: its tasks with status, priority and assignee.",
  parameters: z.object({ project_id: projectId, status: TASK_STATUS.optional() }),
  roles: ['main'],
  run: ({ project_id, status }, _caller, host) => attempt(() => host.actions.boardList(project_id, status)),
})

const boardGet = defineTool({
  name: 'board_get',
  description: 'One board task in full: description, branch, comments and history.',
  parameters: z.object({ project_id: projectId, task: taskNumber }),
  roles: ['main'],
  run: async ({ project_id, task }, _caller, host) => {
    try {
      return await host.actions.boardGet(project_id, task)
    } catch (error) {
      return failure(messageOf(error))
    }
  },
})

const boardCreate = defineTool({
  name: 'board_create',
  description: "Add a task to a project's board (it starts as todo).",
  parameters: z.object({
    project_id: projectId,
    title: z.string(),
    task_description: z.string().optional().describe('What the task is about'),
    priority: z.number().int().min(0).max(4).optional().describe('0 none · 1 low · 2 medium · 3 high · 4 urgent'),
    description: changeDescription,
  }),
  roles: ['main'],
  run: ({ project_id, title, task_description, priority }, _caller, host) =>
    attempt(() =>
      host.actions.boardCreate(project_id, {
        title,
        ...(task_description ? { description: task_description } : {}),
        ...(priority != null ? { priority: priority as 0 | 1 | 2 | 3 | 4 } : {}),
      }),
    ),
})

const boardUpdate = defineTool({
  name: 'board_update',
  description:
    'Change a board task as the user would: status, priority, title. Moving it to done is the review sign-off and merges its branch first; only do that when the user says so.',
  parameters: z.object({
    project_id: projectId,
    task: taskNumber,
    status: TASK_STATUS.optional(),
    priority: z.number().int().min(0).max(4).optional(),
    title: z.string().optional(),
    description: changeDescription,
  }),
  roles: ['main'],
  run: async ({ project_id, task, status, priority, title }, _caller, host) => {
    try {
      return await host.actions.boardUpdate(project_id, task, {
        ...(status ? { status } : {}),
        ...(priority != null ? { priority: priority as 0 | 1 | 2 | 3 | 4 } : {}),
        ...(title ? { title } : {}),
      })
    } catch (error) {
      return failure(messageOf(error))
    }
  },
})

const boardComment = defineTool({
  name: 'board_comment',
  description: "Comment on a board task. If an agent is working on it, it reads the comment and acts on it.",
  parameters: z.object({ project_id: projectId, task: taskNumber, body: z.string(), description: changeDescription }),
  roles: ['main'],
  run: ({ project_id, task, body }, _caller, host) => attempt(() => host.actions.boardComment(project_id, task, body)),
})

const CODING_MODELS = 'coding_agents'

const codingAgents = defineTool({
  name: CODING_MODELS,
  description:
    'The coding agents the user can start in a workspace (Codex, Claude Code, …) with their models. Call it before coding_start and let the user pick the agent and the model.',
  parameters: z.object({
    agent_types: z.array(z.string()).optional().describe('Only these agents; all of them if left out'),
    query: z.string().optional().describe('Narrow the models by id or name, e.g. "sonnet"'),
  }),
  roles: ['main'],
  run: async ({ agent_types, query }, _caller, host) => {
    try {
      return await host.coding.models(agent_types ?? [], query?.trim() || undefined)
    } catch (error) {
      return failure(messageOf(error))
    }
  },
})

const codingStart = defineTool({
  name: 'coding_start',
  description:
    "Start a coding agent on a task in one of the user's workspaces. It runs in a new conversation tab there, which the user can open and take over; you get a notice when it finishes or needs the user. " +
    `The agent and the model are the user's choice: if they have not said and memory.md has no model of theirs for that agent, call ${CODING_MODELS} and ask them first (never pick silently, never re-ask what they already said).`,
  parameters: z.object({
    workspace_id: z.number().int().describe('From workspace_list'),
    title: z.string().describe("3–8 words in the user's language; the conversation tab and the card show it"),
    prompt: z
      .string()
      .describe('Complete, self-contained instructions — the agent cannot see this conversation. It starts in the workspace\'s worktree.'),
    agent: z.string().describe(`An agent id from ${CODING_MODELS}`),
    model: z.string().describe(`A model id from ${CODING_MODELS}, or "default" if the user accepted the agent's own`),
    effort: z
      .string()
      .optional()
      .describe(`Reasoning effort, one of the levels ${CODING_MODELS} lists for that agent and model. Only when the user asked for one or memory.md records theirs; omit for the agent's own`),
    selection_confirmed: z
      .boolean()
      .describe('True only once the user has chosen both the agent and the model — just now, or the model as recorded in memory.md'),
  }),
  roles: ['main'],
  run: async ({ workspace_id, title, prompt, agent, model, effort, selection_confirmed }, _caller, host) => {
    if (!selection_confirmed) return failure(`Ask the user which agent and model to use (${CODING_MODELS} lists them), then call again with selection_confirmed: true.`)
    try {
      return await host.coding.start({ workspaceId: workspace_id, title, prompt, providerId: agent, model, ...(effort?.trim() ? { effort: effort.trim() } : {}) })
    } catch (error) {
      return failure(messageOf(error))
    }
  },
})

const chatId = z.number().int().describe('The chat_id coding_start returned, or from a notice')

const codingSend = defineTool({
  name: 'coding_send',
  description:
    "More instructions for a coding agent you started; it keeps its context. Queued if it is busy. Never use it to answer something the agent asked the user — only the user answers those, in the conversation.",
  parameters: z.object({
    chat_id: chatId,
    message: z.string(),
    title: z.string().optional().describe("When this is a new piece of work for the same agent: its title (3–8 words in the user's language)"),
  }),
  roles: ['main'],
  run: ({ chat_id, message, title }, _caller, host) => attempt(() => host.coding.send(chat_id, message, title)),
})

const codingStatus = defineTool({
  name: 'coding_status',
  description: 'The state and latest reply of a coding agent you started. Results come to you on their own: do not poll.',
  parameters: z.object({ chat_id: chatId }),
  roles: ['main'],
  run: ({ chat_id }, _caller, host) => attempt(() => host.coding.status(chat_id)),
})

const codingStop = defineTool({
  name: 'coding_stop',
  description: "Stop a coding agent's current turn. The conversation stays; it can be given more to do later.",
  parameters: z.object({ chat_id: chatId }),
  roles: ['main'],
  run: ({ chat_id }, _caller, host) => attempt(() => host.coding.stop(chat_id)),
})

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function attempt(run: () => string): ToolResult {
  try {
    return run()
  } catch (error) {
    return failure(messageOf(error))
  }
}

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour')
const scheduleTiming = {
  time: HHMM.describe('Local time it runs at, HH:MM — or where an every-N-minutes window starts'),
  days: z.array(z.number().int().min(0).max(6)).optional().describe('Days it runs, 0 = Sunday. Every day if left out'),
  every_minutes: z.number().int().min(15).optional().describe('Run repeatedly, this many minutes apart, from `time` until `until`'),
  until: HHMM.optional().describe('End of the every-N-minutes window, HH:MM'),
}

function describeSchedule(s: AssistantSchedule): string {
  const next = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : 'none'
  return `- ${s.id} · ${s.name}${s.builtin ? ' (heartbeat, always on)' : ''} · ${s.enabled ? s.cadence : 'paused'} · next: ${next}${s.prompt ? `\n  prompt: ${s.prompt}` : ''}`
}

function scheduleError(error: unknown): ToolResult {
  return failure(error instanceof Error ? error.message : String(error))
}

const scheduleList = defineTool({
  name: 'schedule_list',
  description: 'Your scheduled tasks and the heartbeat, with when they run next.',
  parameters: z.object({}),
  roles: ['main'],
  run: (_args, _caller, host) => host.schedules.list().map(describeSchedule).join('\n') || 'Nothing scheduled.',
})

const scheduleCreate = defineTool({
  name: 'schedule_create',
  description:
    'Set up something to do at set times and report on — a morning brief, a weekly summary. Each run is a helper working on its own with `prompt`, and you get its result to pass on. Not for "tell me if X happens": that goes under "In progress" in memory.md, which the background check watches.',
  parameters: z.object({
    name: z.string().describe("Short name in the user's language, shown in their schedule list"),
    prompt: z.string().describe('Complete instructions for each run; the helper cannot see this conversation'),
    ...scheduleTiming,
    description: changeDescription,
  }),
  roles: ['main'],
  run: ({ name, prompt, time, days, every_minutes, until }, _caller, host) => {
    try {
      const s = host.schedules.create({ name, prompt, time, ...(days ? { days } : {}), ...(every_minutes ? { everyMinutes: every_minutes } : {}), ...(until ? { until } : {}) })
      return `Scheduled:\n${describeSchedule(s)}`
    } catch (error) {
      return scheduleError(error)
    }
  },
})

const scheduleUpdate = defineTool({
  name: 'schedule_update',
  description: 'Change a scheduled task: its name, instructions or timing, or pause / resume it.',
  parameters: z.object({
    id: z.number().int(),
    name: z.string().optional(),
    prompt: z.string().optional(),
    time: scheduleTiming.time.optional(),
    days: scheduleTiming.days,
    every_minutes: scheduleTiming.every_minutes,
    until: scheduleTiming.until,
    enabled: z.boolean().optional().describe('false pauses it, true resumes it'),
    description: changeDescription,
  }),
  roles: ['main'],
  run: ({ id, name, prompt, time, days, every_minutes, until, enabled }, _caller, host) => {
    try {
      const s = host.schedules.update(id, {
        ...(name !== undefined ? { name } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(time !== undefined ? { time } : {}),
        ...(days !== undefined ? { days } : {}),
        ...(every_minutes !== undefined ? { everyMinutes: every_minutes } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      })
      return `Updated:\n${describeSchedule(s)}`
    } catch (error) {
      return scheduleError(error)
    }
  },
})

const scheduleDelete = defineTool({
  name: 'schedule_delete',
  description: 'Delete a scheduled task.',
  parameters: z.object({ id: z.number().int(), description: changeDescription }),
  roles: ['main'],
  run: ({ id }, _caller, host) => {
    try {
      return host.schedules.remove(id) ? 'Deleted.' : `There is no scheduled task ${id}.`
    } catch (error) {
      return scheduleError(error)
    }
  },
})

// ---------------------------------------------------------------------------
// A worker's tools
// ---------------------------------------------------------------------------

const finishTask = defineTool({
  name: 'finish_task',
  description: 'Call exactly once when the task is done, partly done, or cannot be done, then stop.',
  parameters: z.object({
    title: z.string().describe("Short task title, 3–8 words, in the user's language"),
    summary: z.string().describe('One-line result for the user — the answer itself'),
    status: z.enum(['done', 'partial', 'failed']),
  }),
  roles: ['worker'],
  run: (args, caller, host) => (host.finish(caller.id ?? '', args) ? 'Recorded. Stop now.' : failure('This run reports with heartbeat_done, not finish_task.')),
})

const heartbeatDone = defineTool({
  name: 'heartbeat_done',
  description:
    'Background checks only: call exactly once, at the end of the check. List only what is worth interrupting the user for now — an empty list is the usual, right answer.',
  parameters: z.object({
    findings: z
      .array(
        z.object({
          text: z.string().describe("One or two sentences in the user's language, with the specifics: who, what, when"),
          urgent: z.boolean().describe('The user needs it within the hour: a security alert, something due today, something about to be gone'),
        }),
      )
      .describe('Empty when there is nothing new worth saying'),
    unchecked: z
      .array(
        z.object({
          check: z.string().describe('The heading of the heartbeat.md section, as written there'),
          reason: z.string().describe('Briefly, in the user\'s language: "not signed in", "list_alert_rules is missing", "the call timed out", …'),
        }),
      )
      .optional()
      .describe('Checklist sections you could not do this time. Never leave one out: an empty findings list alone reads as "nothing new"'),
  }),
  roles: ['worker'],
  run: (args, caller, host) => (host.heartbeatDone(caller.id ?? '', args) ? 'Recorded. Stop now.' : failure('This is not a background check; finish with finish_task.')),
})

const reportProgress = defineTool({
  name: 'report_progress',
  description: 'Tell the assistant about a milestone worth relaying to the user. At most once or twice per task.',
  parameters: z.object({ text: z.string() }),
  roles: ['worker'],
  run: ({ text }, caller, host) => {
    host.progress(caller.id ?? '', text)
    return 'Sent.'
  },
})

export const ASSISTANT_TOOLS: readonly AssistantTool[] = [
  setIdentity,
  memorySearch,
  startTask,
  continueTask,
  stopTask,
  listTasks,
  workspaceList,
  workspaceOverview,
  waitingList,
  workspaceCreate,
  projectAdd,
  githubPrs,
  githubPr,
  githubPrCreate,
  boardList,
  boardGet,
  boardCreate,
  boardUpdate,
  boardComment,
  codingAgents,
  codingStart,
  codingSend,
  codingStatus,
  codingStop,
  scheduleList,
  scheduleCreate,
  scheduleUpdate,
  scheduleDelete,
  finishTask,
  heartbeatDone,
  reportProgress,
]

/** The tools a kind of session is offered. */
export function toolsFor(role: AssistantRole): AssistantTool[] {
  return ASSISTANT_TOOLS.filter((t) => t.roles.includes(role))
}

/** Every name the assistant's tools go by, for telling them apart from a worker's real work. */
export const ASSISTANT_TOOL_NAMES: ReadonlySet<string> = new Set(ASSISTANT_TOOLS.map((t) => t.name))

/**
 * One call from `caller`, checked against its role and the tool's schema. A call a role may not
 * make is an error the model sees, never a quiet no-op.
 */
export async function callAssistantTool(
  name: string,
  rawArgs: unknown,
  caller: AssistantCaller,
  host: AssistantToolHost,
): Promise<{ text: string; isError?: boolean }> {
  const spec = ASSISTANT_TOOLS.find((t) => t.name === name)
  if (!spec) return { text: `Unknown tool: ${name}`, isError: true }
  if (!spec.roles.includes(caller.role)) return { text: `${name} is not available here.`, isError: true }
  const parsed = spec.parameters.safeParse(rawArgs ?? {})
  if (!parsed.success) return { text: `Invalid arguments for ${name}: ${parsed.error.message}`, isError: true }
  try {
    const result = await spec.run(parsed.data as never, caller, host)
    return typeof result === 'string' ? { text: result } : result
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true }
  }
}

let activeHost: AssistantToolHost | undefined

/** The running assistant serves its tools (set when the runtime starts). */
export function setAssistantToolHost(host: AssistantToolHost | undefined): void {
  activeHost = host
}

export function assistantToolHost(): AssistantToolHost | undefined {
  return activeHost
}
