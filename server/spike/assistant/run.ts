/**
 * Assistant runtime spike (docs/assistant/design.md §10–11).
 *
 * Proves, against real models, the three things the design leans on before any product
 * code is written:
 *   1. One harness can run a narrow main agent and a full-tool worker side by side
 *      (a capability ToolFilter keyed on `isRootAgent`).
 *   2. A background worker finishing wakes an idle main agent, which then speaks.
 *   3. Every worker tool — built-in AND MCP — can be wrapped to take an `intent` argument
 *      that is stripped before the real tool runs.
 * Plus: steering a running worker, worker→main progress, profile_edit, and a worker model
 * that can change between spawns.
 *
 * Run from server/:  npx tsx spike/assistant/run.ts
 * Uses the provider keys of the installed app (read-only).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  createLocalHarness,
  defaultCapabilities,
  defineAgent,
  filesystemTools,
  tool,
  type AgentEvent,
  type Capability,
  type HarnessSession,
  type SubagentProvider,
  type Tool,
  type ToolFilter,
  type ToolPlan,
} from 'operon-agents'
import type { StorageAdapter } from '../../src/storage/interface.js'
import { initProviderConfigService } from '../../src/services/provider-config.js'
import { resolveModel } from '../../src/services/operon-runtime/resolve-model.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = process.env.SPIKE_OUT ?? path.join(os.tmpdir(), `assistant-spike-${Date.now()}`)
const HOME = path.join(OUT, 'home')
const WORK = path.join(OUT, 'work')
const ASSISTANT_DIR = path.join(OUT, 'assistant')
const MCP_LOG = path.join(OUT, 'mcp-args.log')

// ---------------------------------------------------------------------------
// Models: read the app's provider keys, and keep the two model ids in a mutable
// config so the worker model can change between spawns (scenario 6).
// ---------------------------------------------------------------------------

const APP_DB = path.join(os.homedir(), 'Library/Application Support/operon/operon.db')
const providerConfigs: unknown = JSON.parse(
  execFileSync('sqlite3', ['-readonly', APP_DB, "select value from kv where key='ai:provider_configs'"]).toString(),
)
const kvOnly = { get: (key: string) => (key === 'ai:provider_configs' ? providerConfigs : undefined) }
initProviderConfigService(kvOnly as unknown as StorageAdapter)

const config = {
  mainModel: process.env.SPIKE_MAIN_MODEL ?? 'openrouter/anthropic/claude-haiku-4.5',
  workerModel: process.env.SPIKE_WORKER_MODEL ?? 'openrouter/anthropic/claude-sonnet-5',
}

// ---------------------------------------------------------------------------
// Fixture files
// ---------------------------------------------------------------------------

for (const dir of [HOME, WORK, ASSISTANT_DIR]) mkdirSync(dir, { recursive: true })
writeFileSync(path.join(WORK, 'notes.md'), '# Trip notes\n- Leave Beijing on 10/1 at 7am\n- Hotel in Suzhou: near Pingjiang Road\n')
writeFileSync(path.join(WORK, 'todo.md'), '# Todo\n- Book Humble Administrator\'s Garden tickets\n- Charge the car\n')
writeFileSync(path.join(WORK, 'budget.md'), '# Budget\n- Fuel ¥900\n- Hotel ¥1600\n- Food ¥1200\n')
writeFileSync(path.join(ASSISTANT_DIR, 'memory.md'), '# About the user\n- Lives in Beijing\n')

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

let sessionRef: HarnessSession | undefined

/** Main agent only: the single way the definition files change. */
const profileEdit = tool({
  name: 'profile_edit',
  description:
    'Append a line to one of your definition files. Use memory for durable facts about the user ("remember that…").',
  parameters: z.object({
    file: z.enum(['memory', 'soul', 'identity', 'heartbeat']),
    append: z.string().describe('Markdown line(s) to append'),
  }),
  execute: ({ file, append }) => {
    const target = path.join(ASSISTANT_DIR, `${file}.md`)
    const before = existsSync(target) ? readFileSync(target, 'utf8') : ''
    writeFileSync(target, `${before.trimEnd()}\n${append.trim()}\n`)
    return `Appended to ${file}.md`
  },
})

/** Worker only: the structured result the Activity list shows. Ends the worker's turn. */
const workerResults = new Map<string, { title: string; summary: string; status: string }>()
const finishTask = tool({
  name: 'finish_task',
  description: 'Call exactly once when the task is done (or cannot be done). This ends your work.',
  parameters: z.object({
    title: z.string().describe('Short task title, 3–8 words'),
    summary: z.string().describe('One-line result for the user'),
    status: z.enum(['done', 'partial', 'failed']),
  }),
  execute: (args, ctx) => {
    workerResults.set(ctx.address ?? '?', args)
    return { content: [{ type: 'text', text: 'Recorded. Stop now.' }], stopTurn: true }
  },
})

/** Worker only: a milestone the main agent may relay. */
const progressReports: string[] = []
const reportProgress = tool({
  name: 'report_progress',
  description: 'Tell the main assistant about a milestone worth relaying to the user. Use at most once or twice.',
  parameters: z.object({ text: z.string() }),
  execute: ({ text }, ctx) => {
    progressReports.push(text)
    sessionRef?.steerTo('main', `[progress from worker ${ctx.address}] ${text}`, {
      kind: 'external',
      source: 'worker-progress',
      channel: 'steering',
    })
    return 'Sent.'
  },
})

// ---------------------------------------------------------------------------
// The `intent` wrapper and the main/worker tool scope
// ---------------------------------------------------------------------------

const INTENT_DESCRIPTION =
  'One short sentence, in the user\'s language, saying what this call is for (shown to the user as the step label).'

function stripIntent(args: unknown): { intent?: string; rest: unknown } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { rest: args }
  const { intent, ...rest } = args as Record<string, unknown>
  return { intent: typeof intent === 'string' ? intent : undefined, rest }
}

/** Same tool, plus a required `intent` argument that never reaches the real implementation. */
function withIntent(original: Tool): Tool {
  const params = original.schema.parameters
  const properties = (params.properties ?? {}) as Record<string, unknown>
  if ('intent' in properties) return original
  const required = Array.isArray(params.required) ? (params.required as string[]) : []
  // Inherit from the original so every field and prototype method we don't override survives.
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
  Object.defineProperty(wrapped, 'resolve', {
    value: async (args: unknown, ctx: Parameters<Tool['resolve']>[1]): Promise<ToolPlan> => {
      const { intent, rest } = stripIntent(args)
      const plan = await original.resolve(rest, ctx)
      return intent ? { ...plan, display: { ...plan.display, title: intent } } : plan
    },
  })
  if (original.toAutoApprovalInput) {
    const project = original.toAutoApprovalInput.bind(original)
    Object.defineProperty(wrapped, 'toAutoApprovalInput', { value: (args: unknown) => project(stripIntent(args).rest) })
  }
  return wrapped
}

const MAIN_ONLY = new Set(['profile_edit'])
const WORKER_ONLY = new Set(['finish_task', 'report_progress'])
/** What the main agent keeps: dispatch, follow-up, stop, and its own file tool. */
const MAIN_ALLOW = /^(Agent|Background\w*|SendMessage|profile_edit|memory_search)$/

const seenToolSets = new Map<string, string[]>()
const wrapCache = new WeakMap<Tool, Tool>()

const scopeFilter: ToolFilter = (tools, ctx) => {
  const key = ctx.isRootAgent ? 'main' : 'worker'
  if (!seenToolSets.has(key)) seenToolSets.set(key, tools.map((t) => t.schema.name).sort())
  if (ctx.isRootAgent) return tools.filter((t) => MAIN_ALLOW.test(t.schema.name))
  return tools
    .filter((t) => !MAIN_ONLY.has(t.schema.name) && t.schema.name !== 'Agent')
    .map((t) => {
      if (WORKER_ONLY.has(t.schema.name)) return t
      let w = wrapCache.get(t)
      if (!w) {
        w = withIntent(t)
        wrapCache.set(t, w)
      }
      return w
    })
}

const scopeCapability: Capability = { name: 'assistant-scope', contract: 'invariant', toolFilters: [scopeFilter] }

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const MAIN_PROMPT = `You are the user's personal assistant. You only talk; you never do the work yourself.
- Anything that needs a tool (files, weather, web, apps) goes to a background worker: call Agent with subagent_type "worker" and run_in_background true, with a complete, self-contained task description. Do not write anything before calling Agent; after it, reply with exactly one short sentence that you are on it, and end your turn.
- When a worker finishes you get a notification. Read its result with BackgroundOutput if you need details, then tell the user the outcome in a few sentences.
- Progress notes from a worker arrive as messages; relay them in one sentence only if the user would care.
- "Remember …" requests: call profile_edit(file="memory") yourself, no worker.
- Reply in the user's language.`

const WORKER_PROMPT = `You are a worker for a personal assistant. Do the task you were given with your tools.
- Every tool call takes an "intent": one short sentence in the user's language saying what the call is for.
- If the task has two or more parts, call report_progress right after you finish the first part (one sentence on what you found so far).
- When done, call finish_task with a short title, a one-line summary and a status. Then stop.
- If you receive a new instruction while working, fold it into the same task.`

const workerBuilds: string[] = []
const workerProvider: SubagentProvider = {
  list: () => [{ name: 'worker', description: 'Does any task that needs tools: files, MCP apps, research.' }],
  get: (type) => {
    if (type !== 'worker') return undefined
    // Read the config at spawn time: a changed worker model applies to the next worker.
    workerBuilds.push(config.workerModel)
    return defineAgent({
      name: 'worker',
      model: config.workerModel,
      instructions: WORKER_PROMPT,
      tools: [...filesystemTools(), finishTask, reportProgress],
    })
  },
}

const mainAgent = defineAgent({
  name: 'assistant',
  model: config.mainModel,
  instructions: MAIN_PROMPT,
  tools: [profileEdit],
})

// ---------------------------------------------------------------------------
// Event capture helpers
// ---------------------------------------------------------------------------

const events: AgentEvent[] = []

function textOf(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: unknown) =>
      part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : '',
    )
    .join('')
}

function roleOf(message: unknown): string | undefined {
  return message !== null && typeof message === 'object' ? String((message as { role?: unknown }).role) : undefined
}

/** Main-agent text replies (assistant messages at address `main` with visible text). */
function mainReplies(from = 0): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = []
  events.forEach((e, index) => {
    if (index < from || e.type !== 'message.appended' || e.address !== 'main') return
    if (roleOf(e.message) !== 'assistant') return
    const text = textOf(e.message).trim()
    if (text) out.push({ index, text })
  })
  return out
}

function toolCalls(from = 0): { index: number; address: string; name: string; args: unknown }[] {
  const out: { index: number; address: string; name: string; args: unknown }[] = []
  events.forEach((e, index) => {
    if (index >= from && e.type === 'tool.call.started') out.push({ index, address: e.address, name: e.toolName, args: e.args })
  })
  return out
}

function terminatedTasks(from = 0): number {
  return events.filter((e, i) => i >= from && e.type === 'background.task.terminated').length
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait until `done()` holds and the session is idle, or time out. */
async function settle(session: HarnessSession, done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await session.whenIdle()
    if (done()) {
      // Give an idle-wake one more beat to start, then make sure it finished.
      await sleep(1500)
      await session.whenIdle()
      return true
    }
    await sleep(1000)
  }
  return false
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Check {
  name: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
const check = (name: string, pass: boolean, detail: string) => {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
}

async function main(): Promise<void> {
  console.log(`spike output: ${OUT}`)
  console.log(`main=${config.mainModel} worker=${config.workerModel}`)

  const harness = await createLocalHarness({
    model: config.mainModel,
    resolveModel,
    homeDir: HOME,
    workDir: WORK,
    loadDiskProfiles: false,
    loadConfiguredProviders: false,
    agent: mainAgent,
    subagentProvider: workerProvider,
    workflowTool: false,
    permission: { mode: 'yolo' },
    session: (ctx) => [
      ...defaultCapabilities({
        ownEnvironment: ctx.ownEnvironment,
        sessionMcpServers: {
          weather: { transport: 'stdio', command: process.execPath, args: [path.join(HERE, 'echo-mcp.mjs')], env: { SPIKE_MCP_LOG: MCP_LOG } },
        },
      }),
      scopeCapability,
    ],
  })

  const session = await harness.createSession({ workDir: WORK, title: 'assistant-spike' })
  sessionRef = session
  session.onEvent((e) => {
    events.push(e)
    if (e.type === 'tool.call.started') console.log(`  [${e.address}] tool ${e.toolName} ${JSON.stringify(e.args).slice(0, 160)}`)
    if (e.type === 'message.appended' && e.address === 'main' && roleOf(e.message) === 'assistant') {
      const t = textOf(e.message).trim()
      if (t) console.log(`  [main] says: ${t.slice(0, 200)}`)
    }
    if (e.type === 'background.task.started' || e.type === 'background.task.terminated') console.log(`  ${e.type}`)
  })

  try {
    if (process.env.SPIKE_ONLY === 'progress') {
      // 4: a worker milestone reaches main and main relays it, while the worker keeps going.
      console.log('\n== S4 worker progress → main relays it')
      const mark = events.length
      await session.prompt('请安排一个任务：先读 notes.md，读完后马上用 report_progress 汇报读到了什么，然后再查苏州天气，最后完成任务。把这些步骤原样写进任务描述里。')
      const acks = mainReplies(mark).length
      await settle(session, () => terminatedTasks(mark) >= 1 && mainReplies(mark).length > acks + 1, 240_000)
      const relayIdx = events.findIndex((e, i) => i >= mark && e.type === 'message.appended' && e.address === 'main' && textOf(e.message).includes('[progress from worker'))
      const repliesAfterRelay = relayIdx >= 0 ? mainReplies(relayIdx) : []
      check('S4 worker progress reaches main', progressReports.length > 0 && relayIdx >= 0, `reports=${JSON.stringify(progressReports)}`)
      check('S4 main reacts to the progress note', repliesAfterRelay.length > 0, `next main reply: "${repliesAfterRelay[0]?.text.slice(0, 120) ?? ''}"`)
      return
    }

    // 1 + 2 + 3: dispatch, wake, intent (built-in + MCP).
    console.log('\n== S1/S2/S3 dispatch → worker (fs + MCP) → wake main')
    let mark = events.length
    const first = await session.prompt('帮我看一下工作目录里 notes.md 写了什么，再查一下苏州现在的天气，然后一起告诉我。')
    const ackReplies = mainReplies(mark)
    const spawned = toolCalls(mark).filter((c) => c.address === 'main' && c.name === 'Agent')
    check('S2 main dispatches to a background worker', spawned.length > 0 && JSON.stringify(spawned[0]?.args).includes('"run_in_background":true'), `Agent calls=${spawned.length}, first run status=${first.status}`)
    check('S2 main acks without doing the work', ackReplies.length > 0 && toolCalls(mark).every((c) => c.address !== 'main' || MAIN_ALLOW.test(c.name)), `ack="${ackReplies[0]?.text.slice(0, 80) ?? ''}"`)
    const ackCount = ackReplies.length
    const woke = await settle(session, () => terminatedTasks(mark) >= 1 && mainReplies(mark).length > ackCount, 240_000)
    const afterWake = mainReplies(mark).slice(ackCount)
    check('S2 worker completion wakes idle main, which speaks', woke && afterWake.length > 0, `post-completion replies=${afterWake.length}: "${afterWake.at(-1)?.text.slice(0, 120) ?? ''}"`)

    const roots = seenToolSets.get('main') ?? []
    const workers = seenToolSets.get('worker') ?? []
    check('S1 tool scope: main sees a narrow set', true, `main pre-filter has ${roots.length} tools; kept: ${roots.filter((n) => MAIN_ALLOW.test(n)).join(', ')}`)
    check('S1 tool scope: worker sees full set incl. MCP', workers.some((n) => n.includes('get_weather')) && workers.includes('finish_task'), `worker pre-filter: ${workers.join(', ')}`)

    const workerCalls = toolCalls(mark).filter((c) => c.address !== 'main' && !WORKER_ONLY.has(c.name))
    const withIntentArg = workerCalls.filter((c) => typeof (c.args as Record<string, unknown> | null)?.intent === 'string')
    check('S3 worker tool calls carry intent', workerCalls.length > 0 && withIntentArg.length === workerCalls.length, `${withIntentArg.length}/${workerCalls.length}: ${withIntentArg.map((c) => `${c.name}: ${String((c.args as Record<string, unknown>).intent)}`).join(' | ')}`)
    const mcpArgs = existsSync(MCP_LOG) ? readFileSync(MCP_LOG, 'utf8').trim().split('\n').filter(Boolean) : []
    check('S3 MCP server never sees intent', mcpArgs.length > 0 && mcpArgs.every((l) => !l.includes('intent')), `MCP received: ${mcpArgs.join(' ; ') || '(nothing)'}`)
    check('S3 worker returns a structured result', workerResults.size > 0, JSON.stringify([...workerResults.values()]))

    // 5: remember → profile_edit, no worker.
    console.log('\n== S5 remember → profile_edit')
    mark = events.length
    await session.prompt('记住：我不喝咖啡，只喝茶。')
    await settle(session, () => true, 30_000)
    const memory = readFileSync(path.join(ASSISTANT_DIR, 'memory.md'), 'utf8')
    const s5calls = toolCalls(mark)
    check('S5 main writes memory itself', s5calls.some((c) => c.name === 'profile_edit') && !s5calls.some((c) => c.name === 'Agent') && /茶|tea/i.test(memory), `calls=${s5calls.map((c) => c.name).join(',')}; memory.md tail="${memory.trim().split('\n').at(-1)}"`)

    // 6: change the worker model; the next worker picks it up.
    console.log('\n== S6 worker model switch')
    config.workerModel = process.env.SPIKE_WORKER_MODEL_2 ?? 'openrouter/anthropic/claude-haiku-4.5'
    mark = events.length
    const buildsBefore = workerBuilds.length
    await session.prompt('把工作目录里 todo.md 读一下，用一句话总结给我。')
    const ackCount6 = mainReplies(mark).length
    await settle(session, () => terminatedTasks(mark) >= 1 && mainReplies(mark).length > ackCount6, 240_000)
    check('S6 next worker uses the new model', workerBuilds.length > buildsBefore && workerBuilds.at(-1) === config.workerModel, `builds=${JSON.stringify(workerBuilds)}`)
    const haikuFinished = [...workerResults.keys()].some((k) => events.slice(mark).some((e) => e.address === k))
    check('S6 worker (haiku) called finish_task', haikuFinished, `results=${JSON.stringify([...workerResults.entries()].slice(-1))}`)

    // 7: steer a worker that is still running after main's turn ended (session "idle").
    console.log('\n== S7 steer a running background worker while main is idle')
    config.workerModel = process.env.SPIKE_WORKER_MODEL ?? 'openrouter/anthropic/claude-sonnet-5'
    mark = events.length
    await session.prompt('把工作目录里 notes.md、todo.md、budget.md 三个文件都读一遍，再查北京和苏州的天气，最后给我一份出行准备清单。')
    const startedEvent = events.slice(mark).find((e) => e.type === 'agent.started' && e.address !== 'main')
    const workerAddress = startedEvent?.address ?? ''
    const stillRunning = terminatedTasks(mark) === 0
    const viaHarness = workerAddress ? session.steerTo(workerAddress, 'ping', { kind: 'user' }) : undefined
    const viaCore = workerAddress
      ? session.core.steerTo(workerAddress, '另外顺便查一下上海现在的天气，一起写进清单。', { kind: 'user' })
      : undefined
    check('S7 harness steerTo refuses a running background worker when main is idle (framework gap)', stillRunning && viaHarness === undefined, `workerRunning=${stillRunning} harness receipt=${viaHarness === undefined ? 'undefined' : 'ok'}`)
    const ackCount7 = mainReplies(mark).length
    await settle(session, () => terminatedTasks(mark) >= 1 && mainReplies(mark).length > ackCount7, 300_000)
    const shanghai = toolCalls(mark).some((c) => c.address === workerAddress && c.name.includes('get_weather') && JSON.stringify(c.args).includes('shanghai'))
    check('S7 core steerTo reaches the running worker and changes what it does', viaCore !== undefined && shanghai, `core receipt=${viaCore === undefined ? 'undefined' : 'ok'}; shanghai lookup=${shanghai}`)
    check('S4 worker progress reaches main', progressReports.length > 0, `reports=${JSON.stringify(progressReports)}`)
  } finally {
    writeFileSync(path.join(OUT, 'events.json'), JSON.stringify(events, null, 2))
    writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify({ config, checks, seenToolSets: Object.fromEntries(seenToolSets) }, null, 2))
    await harness.close()
  }

  const failed = checks.filter((c) => !c.pass)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Details in ${OUT}`)
  process.exitCode = failed.length > 0 ? 1 : 0
}

await main()
