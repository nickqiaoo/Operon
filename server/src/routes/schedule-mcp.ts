/** Lets any agent create and manage the app's scheduled tasks (the Schedule page) from a conversation. */
import { Hono, type Context } from 'hono'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { CanvasWorkflowStorageAdapter, ChatStorageAdapter, CronjobStorageAdapter, NotificationStorageAdapter, ProjectStorageAdapter } from '../storage/interface.js'
import type { CronjobSchedule, CronjobTask, CronjobUpsertInput } from '../types/cronjob.js'
import { createCronjob, deleteCronjob, executeCronjob, getCronjob, getCronjobExecutionHistory, listCronjobs, updateCronjob } from '../services/cronjob.js'
import { getProviders } from '../services/ai/providers.js'
import { serveMcpOverHono, withCodexElicitationFallback } from './mcp-http.js'
import { resolveMcpCallerChat } from './mcp-caller.js'

export type ScheduleMcpStorage = CronjobStorageAdapter & ChatStorageAdapter & CanvasWorkflowStorageAdapter & ProjectStorageAdapter & NotificationStorageAdapter

const HISTORY_LIMIT = 20
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const scheduleSchema = {
  type: 'object',
  description: 'When it runs, in the user\'s local time. Once a day at `time`, or every `intervalMinutes` between `time` and `endTime`.',
  properties: {
    time: { type: 'string', description: 'HH:MM, 24-hour. The run time, or the window start in interval mode.' },
    days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: 'Days of week, 0 = Sunday. Default Mon–Fri. Use [0,1,2,3,4,5,6] for every day.' },
    intervalMinutes: { type: 'integer', minimum: 1, description: 'Repeat every N minutes inside the window. Requires endTime.' },
    endTime: { type: 'string', description: 'HH:MM, later than time. Window end for interval mode.' },
  },
  required: ['time'],
}

const jobFields = {
  name: { type: 'string', description: 'Short title shown on the Schedule page.' },
  prompt: { type: 'string', description: 'The message sent to the agent on every run. Must be self-contained: the run starts a fresh conversation that cannot see this one.' },
  schedule: scheduleSchema,
  provider_id: { type: 'string', description: 'Agent that runs it (see schedule_list_agents). Default: the agent of this conversation.' },
  model_id: { type: 'string', description: 'Model for that agent. Default: this conversation\'s model when the agent is the same, else the agent\'s own default.' },
  workspace_id: { type: 'integer', description: 'Workspace (project folder) the run works in. Default: this conversation\'s workspace.' },
  enabled: { type: 'boolean', description: 'Default true. False keeps the task but stops it from running on schedule.' },
}

const jobId = { type: 'integer', description: 'Task id from schedule_list.' }

const TOOLS: Tool[] = [
  {
    name: 'schedule_list',
    description: 'List the scheduled tasks on the Schedule page with their timing, next run and last result.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_list_agents',
    description: 'List agents that can run a scheduled task. Only needed when the user asks for a different agent than this conversation\'s.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_create',
    description: 'Create a recurring task that sends `prompt` to an agent on a schedule. Each run opens a new conversation. Before creating, restate the name, timing and prompt to the user unless they already spelled them out.',
    inputSchema: { type: 'object', properties: jobFields, required: ['name', 'prompt', 'schedule'] },
  },
  {
    name: 'schedule_update',
    description: 'Change a scheduled task. Only the fields given change; a given `schedule` replaces the whole schedule.',
    inputSchema: { type: 'object', properties: { id: jobId, ...jobFields }, required: ['id'] },
  },
  {
    name: 'schedule_delete',
    description: 'Delete a scheduled task permanently. Confirm with the user first; to pause it instead, use schedule_update with enabled:false.',
    inputSchema: { type: 'object', properties: { id: jobId }, required: ['id'] },
  },
  {
    name: 'schedule_run_now',
    description: 'Start one run of a scheduled task immediately, outside its schedule. Returns at once; check schedule_history later for the result.',
    inputSchema: { type: 'object', properties: { id: jobId }, required: ['id'] },
  },
  {
    name: 'schedule_history',
    description: 'Recent runs of a scheduled task, newest first, with the chat id each run opened.',
    inputSchema: { type: 'object', properties: { id: jobId }, required: ['id'] },
  },
]

const MUTATING = new Set(['schedule_create', 'schedule_update', 'schedule_delete', 'schedule_run_now'])

type Args = Record<string, unknown>

const text = (args: Args, key: string): string | undefined => {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const requiredId = (args: Args): number => {
  const value = args.id
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('id is required')
  return value
}

const readSchedule = (value: unknown): CronjobSchedule | undefined => {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error('schedule must be an object')
  const raw = value as Record<string, unknown>
  if (typeof raw.time !== 'string') throw new Error('schedule.time is required (HH:MM)')
  const days = Array.isArray(raw.days) ? raw.days.filter((d): d is number => typeof d === 'number') : []
  return {
    type: 'daily',
    time: raw.time,
    days,
    intervalMinutes: typeof raw.intervalMinutes === 'number' ? raw.intervalMinutes : undefined,
    endTime: typeof raw.endTime === 'string' ? raw.endTime : undefined,
  }
}

const describeSchedule = (s: CronjobSchedule): string => {
  const days = s.days.length === 7 ? 'every day' : s.days.map((d) => WEEKDAYS[d]).join(',')
  return s.intervalMinutes
    ? `every ${s.intervalMinutes} min ${s.time}–${s.endTime}, ${days}`
    : `${s.time}, ${days}`
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : undefined)

/** The shape the model reads back: ids, a readable schedule, and no internal timestamps it would misread. */
const summarize = (job: CronjobTask) => ({
  id: job.id,
  name: job.name,
  enabled: job.enabled,
  type: job.taskType,
  schedule: job.schedule,
  when: describeSchedule(job.schedule),
  provider_id: job.providerId || undefined,
  model_id: job.modelId,
  workspace_id: job.workspaceId,
  prompt: job.prompt || undefined,
  canvas_workflow_id: job.canvasWorkflowId,
  next_run_at: iso(job.nextRunAt),
  last_run_at: iso(job.lastRunAt),
  last_result: job.lastResult && { status: job.lastResult.status, error: job.lastResult.error, output: job.lastResult.output },
})

const availableProviderIds = () => getProviders().filter((p) => p.available).map((p) => p.id)

export function buildScheduleMcpServer(storage: ScheduleMcpStorage, callerChatId: number): Server {
  const server = new Server({ name: 'schedule', version: '1.0.0' }, { capabilities: { tools: {} } })
  const caller = callerChatId > 0 ? storage.getChatMeta(callerChatId) : undefined

  const resolveProvider = (args: Args, fallback: { providerId?: string; modelId?: string }) => {
    const providerId = text(args, 'provider_id') ?? fallback.providerId
    if (!providerId) throw new Error('provider_id is required: call schedule_list_agents')
    const available = availableProviderIds()
    if (!available.includes(providerId)) throw new Error(`Unknown or unavailable agent "${providerId}". Available: ${available.join(', ')}`)
    // A model only carries over with the agent it belongs to.
    const modelId = text(args, 'model_id') ?? (providerId === fallback.providerId ? fallback.modelId : undefined)
    return { providerId, modelId }
  }

  const workspaceArg = (args: Args): number | undefined =>
    typeof args.workspace_id === 'number' ? args.workspace_id : undefined

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Args
    const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
    try {
      const name = req.params.name
      // A scheduled run carries this server too; letting it create or fire tasks would let a
      // task multiply itself on every run.
      if (MUTATING.has(name) && caller?.tp === 'cronjob') throw new Error('Scheduled runs cannot change scheduled tasks.')

      if (name === 'schedule_list') return json({ tasks: listCronjobs(storage).map(summarize) })
      if (name === 'schedule_list_agents') {
        return json({ agents: getProviders().filter((p) => p.available).map((p) => ({ provider_id: p.id, name: p.label })), current: caller?.providerId })
      }
      if (name === 'schedule_create') {
        const schedule = readSchedule(args.schedule)
        if (!schedule) throw new Error('schedule is required')
        const { providerId, modelId } = resolveProvider(args, { providerId: caller?.providerId, modelId: caller?.model })
        const input: CronjobUpsertInput = {
          name: text(args, 'name') ?? '',
          enabled: args.enabled !== false,
          taskType: 'chat',
          providerId,
          modelId,
          thinkingLevel: providerId === caller?.providerId ? caller?.thinkingLevel : undefined,
          workspaceId: workspaceArg(args) ?? caller?.workspaceId,
          prompt: text(args, 'prompt'),
          schedule,
        }
        return json({ task: summarize(createCronjob(storage, input)) })
      }

      const id = requiredId(args)
      const current = getCronjob(storage, id)
      if (!current) throw new Error(`Scheduled task ${id} not found`)

      if (name === 'schedule_update') {
        const provider = current.taskType === 'chat'
          ? resolveProvider(args, { providerId: current.providerId, modelId: current.modelId })
          : { providerId: current.providerId, modelId: current.modelId }
        const input: CronjobUpsertInput = {
          name: text(args, 'name') ?? current.name,
          enabled: typeof args.enabled === 'boolean' ? args.enabled : current.enabled,
          taskType: current.taskType,
          canvasWorkflowId: current.canvasWorkflowId,
          providerId: provider.providerId,
          modelId: provider.modelId,
          modeId: current.modeId,
          thinkingLevel: provider.providerId === current.providerId ? current.thinkingLevel : undefined,
          workspaceId: workspaceArg(args) ?? current.workspaceId,
          prompt: text(args, 'prompt') ?? current.prompt,
          schedule: readSchedule(args.schedule) ?? current.schedule,
        }
        const updated = updateCronjob(storage, id, input)
        if (!updated) throw new Error(`Scheduled task ${id} not found`)
        return json({ task: summarize(updated) })
      }
      if (name === 'schedule_delete') {
        deleteCronjob(storage, id)
        return json({ deleted: id })
      }
      if (name === 'schedule_run_now') {
        // A run lasts as long as the agent works; holding the tool call open would time it out.
        void executeCronjob(storage, id).catch((error) => console.error(`[schedule-mcp] run ${id} failed:`, error))
        return json({ started: id, note: 'Running in the background. Check schedule_history for the result.' })
      }
      if (name === 'schedule_history') {
        const history = getCronjobExecutionHistory(storage, id).slice(0, HISTORY_LIMIT)
        return json({ runs: history.map((run) => ({ chat_id: run.chatId, at: iso(run.timestamp), status: run.status, title: run.title })) })
      }
      throw new Error(`Unknown tool: ${name}`)
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  })
  return withCodexElicitationFallback(server)
}

export function scheduleMcpRoutes(storage: ScheduleMcpStorage) {
  const router = new Hono()
  const handle = async (c: Context) => {
    const caller = await resolveMcpCallerChat(c, 'chatId')
    if (!caller.ok) return caller.response
    return serveMcpOverHono(c, buildScheduleMcpServer(storage, caller.chatId ?? 0), caller.body)
  }
  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)
  return router
}
