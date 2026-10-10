import { tool, type Capability, type Tool, type ToolFilter, type ToolPlan } from 'operon-agents'
import { z } from 'zod'
import type { AssistantSchedule, ProfileFileName } from '../../../../shared/assistant.js'
import { MemoryService } from '../memory/index.js'
import { execMemorySearch } from '../memory/operations.js'
import { MEMORY_SOFT_LIMIT } from './defaults.js'
import { readProfileFile, writeProfileFile } from './files.js'
import { ASSISTANT_CALLER_ARG } from './node-repl-bridge.js'
import type { ScheduleInput } from './schedule.js'

/** A worker as the main agent sees it when listing. */
export interface TaskListing {
  id: string
  title: string
  status: string
  summary: string
}

/** What the tools need from the running assistant, resolved lazily (sessions come later). */
export interface AssistantToolHost {
  /** Start a worker on a task; returns its id. `toolCallId` is the main agent's dispatch call. */
  startTask(input: { title: string; prompt: string }, toolCallId: string): Promise<string>
  /** Add to a running task, or pick a finished one back up. */
  continueTask(id: string, message: string): Promise<'delivered' | 'continued' | 'missing'>
  stopTask(id: string): Promise<boolean>
  listTasks(): TaskListing[]
  /** A milestone a worker wants passed on. */
  progress(activityId: string, text: string): void
  /** A line was saved to memory.md during the current main turn. */
  onRemembered(line: string): void
  /** A definition file changed through a tool. */
  onFileWritten(name: ProfileFileName): void
}

// ---------------------------------------------------------------------------
// Main agent tools
// ---------------------------------------------------------------------------

export function profileEditTool(host: AssistantToolHost): Tool {
  return tool({
    name: 'profile_edit',
    description:
      'Change one of your definition files: memory (what you always know about the user), soul (your personality), heartbeat (extra things to keep an eye on). Append a line, or replace an exact piece of text (use an empty `text` to delete it).',
    parameters: z.object({
      file: z.enum(['memory', 'soul', 'heartbeat']),
      action: z.enum(['append', 'replace']),
      text: z.string().describe('Markdown to append, or the replacement text'),
      old_text: z.string().optional().describe('For replace: the exact text currently in the file'),
    }),
    // The assistant's own notes about the user: nothing for the auto-approval judge to weigh.
    toAutoApprovalInput: () => '',
    execute: ({ file, action, text, old_text }) => {
      const current = readProfileFile(file).content
      let next: string
      if (action === 'append') {
        next = `${current.trimEnd()}\n${text.trim()}\n`
      } else {
        if (!old_text || !current.includes(old_text)) {
          return { content: [{ type: 'text', text: `old_text was not found in ${file}.md; read the file in your instructions and try again.` }], isError: true }
        }
        next = current.replace(old_text, text)
      }
      writeProfileFile(file, next, 'assistant')
      host.onFileWritten(file)
      if (file === 'memory' && action === 'append') {
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
}

/** identity.md's frontmatter, field by field — no text matching on `name:` vs `user_name:`. */
export function setIdentityTool(host: AssistantToolHost): Tool {
  return tool({
    name: 'set_identity',
    description: "Set your own name and/or what you call the user, in identity.md.",
    parameters: z.object({
      name: z.string().optional().describe('Your name'),
      user_name: z.string().optional().describe('What you call the user'),
    }),
    toAutoApprovalInput: () => '',
    execute: ({ name, user_name }) => {
      let content = readProfileFile('identity').content
      if (!/^---\n[\s\S]*?\n---/.test(content)) content = `---\n---\n\n${content}`
      const setField = (text: string, key: string, value: string) => {
        const line = new RegExp(`^${key}:.*$`, 'm')
        return line.test(text) ? text.replace(line, `${key}: ${value}`) : text.replace(/^---\n/, `---\n${key}: ${value}\n`)
      }
      if (name?.trim()) content = setField(content, 'name', name.trim())
      if (user_name?.trim()) content = setField(content, 'user_name', user_name.trim())
      writeProfileFile('identity', content, 'assistant')
      host.onFileWritten('identity')
      return 'Saved identity.md.'
    },
  })
}

export const memorySearchTool: Tool = tool({
  name: 'memory_search',
  description: "Search older memories about the user that aren't in memory.md (past events, details, people).",
  parameters: z.object({
    query: z.string(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  toAutoApprovalInput: () => '',
  execute: async ({ query, limit }) => {
    let engine
    try {
      engine = MemoryService.getInstance().getEngine()
    } catch {
      return 'Memory search is not available.'
    }
    return execMemorySearch(engine, { query, limit: limit ?? 8 })
  },
})

export function startTaskTool(host: AssistantToolHost): Tool {
  return tool({
    name: 'start_task',
    description:
      'Hand a task to a helper that works in the background with tools (files, apps, the web, connected accounts). Returns at once with the task id; you get a notice when it finishes.',
    parameters: z.object({
      title: z.string().describe("3–8 words in the user's language; the user sees it as the task title"),
      prompt: z.string().describe('Complete, self-contained instructions — the helper cannot see this conversation'),
    }),
    toAutoApprovalInput: () => '',
    execute: async ({ title, prompt }, ctx) => {
      const id = await host.startTask({ title, prompt }, ctx.toolCallId)
      return `Started task ${id}.`
    },
  })
}

export function continueTaskTool(host: AssistantToolHost): Tool {
  return tool({
    name: 'continue_task',
    description:
      'Send more instructions to a task. A running task folds them in; a finished one picks up where it left off, with everything it already did still in its context.',
    parameters: z.object({
      task_id: z.string(),
      message: z.string(),
    }),
    toAutoApprovalInput: () => '',
    execute: async ({ task_id, message }) => {
      const result = await host.continueTask(task_id, message)
      if (result === 'missing') return { content: [{ type: 'text', text: `There is no task ${task_id}.` }], isError: true }
      return result === 'delivered' ? 'Delivered to the running task.' : 'The task is working on it again.'
    },
  })
}

export function stopTaskTool(host: AssistantToolHost): Tool {
  return tool({
    name: 'stop_task',
    description: 'Stop a running task.',
    parameters: z.object({ task_id: z.string() }),
    toAutoApprovalInput: () => '',
    execute: async ({ task_id }) => ((await host.stopTask(task_id)) ? 'Stopped.' : 'That task is not running.'),
  })
}

export function listTasksTool(host: AssistantToolHost): Tool {
  return tool({
    name: 'list_tasks',
    description: 'The most recent tasks with their status and one-line result — for when the user asks how things are going.',
    parameters: z.object({}),
    toAutoApprovalInput: () => '',
    execute: () => {
      const tasks = host.listTasks()
      if (!tasks.length) return 'No tasks yet.'
      return tasks.map((t) => `- ${t.id} · ${t.status} · ${t.title} — ${t.summary}`).join('\n')
    },
  })
}

/** The schedule tools' view of the assistant (schedule.ts does the work). */
export interface ScheduleToolHost {
  list(): AssistantSchedule[]
  create(input: ScheduleInput): AssistantSchedule
  update(id: number, patch: Partial<ScheduleInput> & { enabled?: boolean }): AssistantSchedule
  remove(id: number): boolean
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

function scheduleError(error: unknown) {
  return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
}

export function scheduleTools(host: ScheduleToolHost): Tool[] {
  return [
    tool({
      name: 'schedule_list',
      description: 'Your scheduled tasks and the heartbeat, with when they run next.',
      parameters: z.object({}),
      toAutoApprovalInput: () => '',
      execute: () => host.list().map(describeSchedule).join('\n') || 'Nothing scheduled.',
    }),
    tool({
      name: 'schedule_create',
      description:
        'Set up something to do at set times and report on — a morning brief, a weekly summary. Each run is a helper working on its own with `prompt`, and you get its result to pass on. Not for "tell me if X happens": that goes in heartbeat.md.',
      parameters: z.object({
        name: z.string().describe("Short name in the user's language, shown in their schedule list"),
        prompt: z.string().describe('Complete instructions for each run; the helper cannot see this conversation'),
        ...scheduleTiming,
      }),
      toAutoApprovalInput: () => '',
      execute: ({ name, prompt, time, days, every_minutes, until }) => {
        try {
          const s = host.create({ name, prompt, time, ...(days ? { days } : {}), ...(every_minutes ? { everyMinutes: every_minutes } : {}), ...(until ? { until } : {}) })
          return `Scheduled:\n${describeSchedule(s)}`
        } catch (error) {
          return scheduleError(error)
        }
      },
    }),
    tool({
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
      toAutoApprovalInput: () => '',
      execute: ({ id, name, prompt, time, days, every_minutes, until, enabled }) => {
        try {
          const s = host.update(id, {
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
    }),
    tool({
      name: 'schedule_delete',
      description: 'Delete a scheduled task.',
      parameters: z.object({ id: z.number().int() }),
      toAutoApprovalInput: () => '',
      execute: ({ id }) => {
        try {
          return host.remove(id) ? 'Deleted.' : `There is no scheduled task ${id}.`
        } catch (error) {
          return scheduleError(error)
        }
      },
    }),
  ]
}

// ---------------------------------------------------------------------------
// Worker tools
// ---------------------------------------------------------------------------

export const finishTaskTool: Tool = tool({
  name: 'finish_task',
  description: 'Call exactly once when the task is done, partly done, or cannot be done. This ends your work.',
  parameters: z.object({
    title: z.string().describe('Short task title, 3–8 words, in the user\'s language'),
    summary: z.string().describe('One-line result for the user'),
    status: z.enum(['done', 'partial', 'failed']),
  }),
  toAutoApprovalInput: () => '',
  // The structured result is read off the tool call by the activity projector.
  execute: () => ({ content: [{ type: 'text', text: 'Recorded. Stop now.' }], stopTurn: true }),
})

export const heartbeatDoneTool: Tool = tool({
  name: 'heartbeat_done',
  description:
    'Call exactly once, at the end of the check. List only what is worth interrupting the user for now — an empty list is the usual, right answer.',
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
  toAutoApprovalInput: () => '',
  execute: () => ({ content: [{ type: 'text', text: 'Recorded. Stop now.' }], stopTurn: true }),
})

export function reportProgressTool(host: AssistantToolHost, activityId: string): Tool {
  return tool({
    name: 'report_progress',
    description: 'Tell the assistant about a milestone worth relaying to the user. At most once or twice per task.',
    parameters: z.object({ text: z.string() }),
    toAutoApprovalInput: () => '',
    execute: ({ text }) => {
      host.progress(activityId, text)
      return 'Sent.'
    },
  })
}

// ---------------------------------------------------------------------------
// Scope: which frame sees which tool, and the `intent` argument on worker tools
// ---------------------------------------------------------------------------

/** What the main agent keeps from the assembled registry. */
export const MAIN_TOOLS = new Set([
  'start_task',
  'continue_task',
  'stop_task',
  'list_tasks',
  'profile_edit',
  'set_identity',
  'memory_search',
  'schedule_list',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
])
/** Framework tools a worker must not use: helpers of its own (it is the helper), the framework's
 *  own cron (schedules go through the app's cronjob service), goals. A worker's agent never has
 *  the main agent's tools to begin with — each kind of session has its own agent. */
const WORKER_HIDDEN = new Set(['Agent', 'CronCreate', 'CronDelete', 'CronList', 'GetGoal'])
/** Worker tools that are about the task itself, not a step of it. */
const NO_INTENT = new Set(['finish_task', 'report_progress', 'heartbeat_done'])

const INTENT_DESCRIPTION =
  "One short sentence, in the user's language, saying what this call is for. Shown to the user as the step name."

export function stripIntent(args: unknown): { intent?: string; rest: unknown } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { rest: args }
  const { intent, ...rest } = args as Record<string, unknown>
  return { intent: typeof intent === 'string' && intent.trim() ? intent.trim() : undefined, rest }
}

/**
 * The same tool, plus a required `intent` argument that never reaches the real implementation.
 * @param callerId the worker making the calls, named on node_repl calls (see below).
 */
export function withIntent(original: Tool, callerId?: string): Tool {
  const params = original.schema.parameters
  const properties = (params.properties ?? {}) as Record<string, unknown>
  if ('intent' in properties) return original
  const required = Array.isArray(params.required) ? (params.required as string[]) : []
  // Inherit from the original so every field and method we don't override survives.
  const wrapped: Tool = Object.create(original)
  Object.defineProperty(wrapped, 'schema', {
    value: {
      ...original.schema,
      parameters: {
        ...params,
        type: 'object',
        properties: { intent: { type: 'string', description: INTENT_DESCRIPTION }, ...properties },
        required: ['intent', ...required],
      },
    },
  })
  // node_repl is mounted without a conversation id; each call says which worker it is, so the
  // route can give every worker its own vm context in the shared kernel (node-repl-bridge.ts).
  const namesWorker = callerId !== undefined && original.schema.name.startsWith('mcp__node_repl__')
  Object.defineProperty(wrapped, 'resolve', {
    value: async (args: unknown, ctx: Parameters<Tool['resolve']>[1]): Promise<ToolPlan> => {
      const { intent, rest } = stripIntent(args)
      const plan = await original.resolve(rest, ctx)
      const titled = intent ? { ...plan, display: { ...plan.display, title: intent } } : plan
      if (!namesWorker || rest === null || typeof rest !== 'object' || Array.isArray(rest)) return titled
      // The framework's MCP tool sends the very object it was resolved with, so naming the worker
      // on it just before running is what reaches the server — after the resolve-time checks,
      // which never see the hidden argument.
      const sent = rest as Record<string, unknown>
      return {
        ...titled,
        run: (runCtx) => {
          sent[ASSISTANT_CALLER_ARG] = callerId
          return titled.run(runCtx)
        },
      }
    },
  })
  // The auto-approval judge must see the real arguments, never the model's own description of
  // them ("harmless, trust me"). Without a projection of its own the judge would fall back to
  // the raw arguments — intent included — so a stripped copy is the default.
  const project = original.toAutoApprovalInput?.bind(original)
  Object.defineProperty(wrapped, 'toAutoApprovalInput', {
    value: (args: unknown) => {
      const rest = stripIntent(args).rest
      return project ? project(rest) : rest
    },
  })
  return wrapped
}

/** The main agent's session: talking, dispatching and its own notes — nothing that acts. */
export const mainScopeFilter: ToolFilter = (tools) => tools.filter((t) => MAIN_TOOLS.has(t.schema.name))

/**
 * A worker's session (the worker is its root): the working tools, each asking for an `intent`.
 * One filter per worker, so the wrapped tools name that worker and are reused across its turns.
 */
export function workerScopeFilter(workerId: string): ToolFilter {
  const wrapCache = new WeakMap<Tool, Tool>()
  return (tools) =>
    tools
      .filter((t) => !WORKER_HIDDEN.has(t.schema.name))
      .map((t) => {
        if (NO_INTENT.has(t.schema.name)) return t
        let wrapped = wrapCache.get(t)
        if (!wrapped) {
          wrapped = withIntent(t, workerId)
          wrapCache.set(t, wrapped)
        }
        return wrapped
      })
}

export const mainScopeCapability: Capability = {
  name: 'assistant-scope',
  contract: 'invariant',
  toolFilters: [mainScopeFilter],
}

export function workerScopeCapability(workerId: string): Capability {
  return { name: 'assistant-scope', contract: 'invariant', toolFilters: [workerScopeFilter(workerId)] }
}
