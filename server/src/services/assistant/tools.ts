import { z } from 'zod'
import type { AssistantSchedule, ProfileFileName } from '../../../../shared/assistant.js'
import { MemoryService } from '../memory/index.js'
import { execMemorySearch } from '../memory/operations.js'
import { MEMORY_SOFT_LIMIT } from './defaults.js'
import { readProfileFile, writeProfileFile } from './files.js'
import type { AssistantCaller, AssistantRole } from './node-repl-bridge.js'
import type { ScheduleInput } from './schedule.js'

/**
 * The assistant's own tools — the main agent's, a worker's, the wrap-up's — whatever agent runs
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
  remove_lines?: string[]
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
  /** A line was saved to memory.md by the main agent. */
  onRemembered(line: string): void
  /** A definition file changed through a tool, by `role`. */
  onFileWritten(name: ProfileFileName, role: AssistantRole): void
  schedules: ScheduleToolHost
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
// The main agent's tools (and the wrap-up's one)
// ---------------------------------------------------------------------------

const profileEdit = defineTool({
  name: 'profile_edit',
  description:
    'Change one of your definition files: memory (what you always know about the user), soul (your personality), heartbeat (extra things to keep an eye on). Append a line, or replace an exact piece of text (use an empty `text` to delete it).',
  parameters: z.object({
    file: z.enum(['memory', 'soul', 'heartbeat']),
    action: z.enum(['append', 'replace']),
    text: z.string().describe('Markdown to append, or the replacement text'),
    old_text: z.string().optional().describe('For replace: the exact text currently in the file'),
  }),
  roles: ['main', 'wrapup'],
  run: ({ file, action, text, old_text }, caller, host) => {
    // The wrap-up keeps memory.md and nothing else.
    if (caller.role === 'wrapup' && file !== 'memory') return failure('Only memory.md can be changed here.')
    const current = readProfileFile(file).content
    let next: string
    if (action === 'append') {
      next = `${current.trimEnd()}\n${text.trim()}\n`
    } else {
      if (!old_text || !current.includes(old_text)) {
        return failure(`old_text was not found in ${file}.md; read the file in your instructions and try again.`)
      }
      next = current.replace(old_text, text)
    }
    writeProfileFile(file, next, 'assistant')
    host.onFileWritten(file, caller.role)
    if (caller.role === 'main' && file === 'memory' && action === 'append') {
      // The fact itself, not the heading the model may have written above it.
      const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      const line = (lines.find((l) => /^[-*]\s/.test(l)) ?? lines[0])?.replace(/^[-*]\s*/, '').trim()
      if (line) host.onRemembered(line)
    }
    const warn = file === 'memory' && next.length > MEMORY_SOFT_LIMIT
      ? ` memory.md is now ${next.length} characters, over the ${MEMORY_SOFT_LIMIT} limit: merge or drop stale lines.`
      : ''
    return `Saved ${file}.md.${warn}`
  },
})

/** identity.md's frontmatter, field by field — no text matching on `name:` vs `user_name:`. */
const setIdentity = defineTool({
  name: 'set_identity',
  description: 'Set your own name and/or what you call the user, in identity.md.',
  parameters: z.object({
    name: z.string().optional().describe('Your name'),
    user_name: z.string().optional().describe('What you call the user'),
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
    'Set up something to do at set times and report on — a morning brief, a weekly summary. Each run is a helper working on its own with `prompt`, and you get its result to pass on. Not for "tell me if X happens": that goes in heartbeat.md.',
  parameters: z.object({
    name: z.string().describe("Short name in the user's language, shown in their schedule list"),
    prompt: z.string().describe('Complete instructions for each run; the helper cannot see this conversation'),
    ...scheduleTiming,
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
  parameters: z.object({ id: z.number().int() }),
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
    remove_lines: z.array(z.string()).optional().describe('Lines of heartbeat.md whose "until" date has passed, copied exactly'),
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
  profileEdit,
  setIdentity,
  memorySearch,
  startTask,
  continueTask,
  stopTask,
  listTasks,
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
